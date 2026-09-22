// DynamoDB single-table store (SPEC.md §4.2). Records are JSON in `data`;
// attributes used in conditions/updates (`status`, `restaurant_id`, country
// counters, `ttl`) are top level.

import {
  CreateTableCommand,
  DynamoDBClient,
  ConditionalCheckFailedException,
  TransactionCanceledException,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { PickSession } from "../domain/session";
import type { LogEntry, Restaurant } from "../domain/status";
import {
  ConflictError,
  GEOCODE_TTL_MS,
  GUESS_TTL_MS,
  logKey,
  pickedAfter,
  PICK_TTL_MS,
  PickCancelled,
  StoreUnavailable,
  type CachedGuess,
  type CachedLocation,
  type Change,
  type CountryVisits,
  type HistoryPage,
  type Store,
} from "../domain/store";
import { ms } from "../domain/time";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

const META = "META";
const restaurantPk = (id: string) => `RESTAURANT#${id}`;

/** The single operation on the STATE/PICKED pointer within a change. */
export type PointerOp =
  | { op: "check"; expected: string | null }
  | { op: "set"; expected: string | null; to: string }
  | { op: "clear"; expected: string };

export function pointerOp(change: Change): PointerOp {
  const after = pickedAfter(change);
  const expected = change.expected_picked;
  if (after === expected) return { op: "check", expected };
  if (after !== null) return { op: "set", expected, to: after };
  return { op: "clear", expected: expected as string };
}

function pointerCondition(expected: string | null) {
  return expected === null
    ? { ConditionExpression: "attribute_not_exists(pk)" }
    : {
        ConditionExpression: "restaurant_id = :expected",
        ExpressionAttributeValues: { ":expected": expected },
      };
}

const ttl = (createdAt: string, ttlMs: number) => Math.floor((ms(createdAt) + ttlMs) / 1000);

export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  private async get(pk: string, sk: string): Promise<Record<string, unknown> | null> {
    try {
      const out = await this.doc.send(
        new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }),
      );
      return out.Item ?? null;
    } catch (e) {
      throw new StoreUnavailable(String(e));
    }
  }

  private async getData<T>(pk: string, sk: string): Promise<T | null> {
    const item = await this.get(pk, sk);
    return item ? (JSON.parse(item.data as string) as T) : null;
  }

  private async putData(pk: string, sk: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk, sk, data: JSON.stringify(value), ttl: ttlSeconds },
        }),
      );
    } catch (e) {
      throw new StoreUnavailable(String(e));
    }
  }

  getRestaurant(id: string) {
    return this.getData<Restaurant>(restaurantPk(id), META);
  }

  async currentlyPicked() {
    const item = await this.get("STATE", "PICKED");
    return item ? this.getRestaurant(item.restaurant_id as string) : null;
  }

  /** The transaction for a change (exported for tests). */
  transactItems(change: Change): TransactItem[] {
    const items: TransactItem[] = [];
    for (const t of change.transitions) {
      const r = t.restaurant;
      items.push({
        Put: {
          TableName: this.table,
          Item: { pk: restaurantPk(r.id), sk: META, data: JSON.stringify(r), status: r.status ?? undefined },
          ExpressionAttributeNames: { "#s": "status" },
          ...(t.expected_status === null
            ? { ConditionExpression: "attribute_not_exists(#s)" }
            : {
                ConditionExpression: "#s = :expected_status",
                ExpressionAttributeValues: { ":expected_status": t.expected_status },
              }),
        },
      });
      items.push({
        Put: { TableName: this.table, Item: { pk: "LOG", sk: logKey(t.log), data: JSON.stringify(t.log) } },
      });
      if (t.country_visited) {
        items.push({
          Update: {
            TableName: this.table,
            Key: { pk: "COUNTRY", sk: t.log.country_iso },
            UpdateExpression:
              "ADD visit_count :one SET last_visited_at = :at, first_visited_at = if_not_exists(first_visited_at, :at)",
            ExpressionAttributeValues: { ":one": 1, ":at": t.log.at },
          },
        });
      }
    }
    const key = { pk: "STATE", sk: "PICKED" };
    const p = pointerOp(change);
    if (p.op === "check") {
      items.push({ ConditionCheck: { TableName: this.table, Key: key, ...pointerCondition(p.expected) } });
    } else if (p.op === "set") {
      items.push({
        Put: {
          TableName: this.table,
          Item: { ...key, restaurant_id: p.to },
          ...pointerCondition(p.expected),
        },
      });
    } else {
      items.push({ Delete: { TableName: this.table, Key: key, ...pointerCondition(p.expected) } });
    }
    return items;
  }

  async apply(change: Change) {
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: this.transactItems(change) }));
    } catch (e) {
      if (
        e instanceof TransactionCanceledException &&
        e.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")
      ) {
        throw new ConflictError();
      }
      throw new StoreUnavailable(String(e));
    }
  }

  async countryVisits(): Promise<CountryVisits[]> {
    const out: CountryVisits[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const resp = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": "COUNTRY" },
          ExclusiveStartKey: start,
          ConsistentRead: true,
        }),
      );
      for (const i of resp.Items ?? []) {
        out.push({
          iso2: i.sk as string,
          visit_count: Number(i.visit_count ?? 0),
          first_visited_at: (i.first_visited_at as string | undefined) ?? null,
          last_visited_at: (i.last_visited_at as string | undefined) ?? null,
        });
      }
      start = resp.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async history(cursor: string | null, limit: number): Promise<HistoryPage> {
    const resp = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: cursor === null ? "pk = :pk" : "pk = :pk AND sk < :cursor",
        ExpressionAttributeValues: cursor === null ? { ":pk": "LOG" } : { ":pk": "LOG", ":cursor": cursor },
        ScanIndexForward: false,
        Limit: limit + 1,
        ConsistentRead: true,
      }),
    );
    const items = resp.Items ?? [];
    const page = items.slice(0, limit);
    return {
      entries: page.map((i) => JSON.parse(i.data as string) as LogEntry),
      next_cursor: items.length > limit ? ((page.at(-1)?.sk as string | undefined) ?? null) : null,
    };
  }

  getPick(pickId: string) {
    return this.getData<PickSession>(`PICK#${pickId}`, META);
  }

  /** A cancelled pick carries a top-level `cancelled` flag; other writes must not find it (F12.2). */
  async putPick(s: PickSession) {
    const cancelled = s.status === "cancelled";
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: `PICK#${s.pick_id}`,
            sk: META,
            data: JSON.stringify(s),
            ttl: ttl(s.created_at, PICK_TTL_MS),
            cancelled: cancelled ? true : undefined,
          },
          ConditionExpression: cancelled ? undefined : "attribute_not_exists(cancelled)",
        }),
      );
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new PickCancelled(s.pick_id);
      throw new StoreUnavailable(String(e));
    }
  }

  getGuess(placeId: string, promptVersion: number) {
    return this.getData<CachedGuess>(`PLACE#${placeId}`, `GUESS#v${promptVersion}`);
  }

  putGuess(g: CachedGuess) {
    return this.putData(
      `PLACE#${g.guess.place_id}`,
      `GUESS#v${g.prompt_version}`,
      g,
      ttl(g.created_at, GUESS_TTL_MS),
    );
  }

  getGeocode(key: string) {
    return this.getData<CachedLocation>(`GEOCODE#${key}`, META);
  }

  putGeocode(key: string, v: CachedLocation) {
    return this.putData(`GEOCODE#${key}`, META, v, ttl(v.created_at, GEOCODE_TTL_MS));
  }
}

/** Create the table with the §4.2 key schema (local development and tests; Terraform owns the real one). */
export async function createTable(config: DynamoDBClientConfig, table: string): Promise<void> {
  await new DynamoDBClient(config).send(
    new CreateTableCommand({
      TableName: table,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
}
