// Runs the store contract against DynamoDB Local. Used by `make it`, not `make check`.
// FAT_HORSES_DYNAMODB_ENDPOINT defaults to http://localhost:8000.

import { DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { runContract, CONTRACT_SCENARIOS } from "../src/store/contract";
import { createTable, DynamoStore } from "../src/store/dynamo";

const config = {
  endpoint: process.env.FAT_HORSES_DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  region: "ap-southeast-2",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
};
const client = new DynamoDBClient(config);
const tables: string[] = [];

await runContract(async () => {
  const name = `contract-${process.pid}-${tables.length}`;
  await createTable(config, name);
  tables.push(name);
  return new DynamoStore(name, client);
});
for (const t of tables) await client.send(new DeleteTableCommand({ TableName: t })).catch(() => undefined);
console.log(`dynamo contract: OK (${CONTRACT_SCENARIOS.length} scenarios)`);
