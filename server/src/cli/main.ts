// `fat-horses`: run picks and manage visits from the terminal.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { nominatimFromEnv, Overpass } from "../adapters/osm";
import { identityFromEnv, TabNz } from "../adapters/tabNz";
import {
  AddressNotFound,
  AmbiguousAddress,
  DEFAULT_RADIUS_M,
  InvalidRequest,
  newPickId,
  startPick,
} from "../app/start";
import { defaultConfig, runPick, systemClock } from "../app/workflow";
import { FakeClassifier } from "../domain/classify";
import { bundledCountries } from "../domain/countries";
import { DEFAULT_MIN_POPULATION } from "../domain/pool";
import { systemRng } from "../domain/rng";
import { HISTORY_PAGE, NotFoundError, recordSkip, recordVisit } from "../domain/store";
import { defaultStorePath, FileStore } from "../store/file";
import * as render from "./render";
import { serve } from "./serve";

const USAGE = `Usage: fat-horses [--store PATH] <command>

Commands:
  pick <address> [--radius M] [--max-wait MIN] [--min-population N] [--include-visited] --fake-llm
  visit <restaurant-id>
  skip <restaurant-id>
  passport [--min-population N]
  history [--cursor C]
  serve --api-key KEY [--port 8080] [--web DIR]   (or FAT_HORSES_API_KEY)
`;

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      store: { type: "string" },
      radius: { type: "string" },
      "max-wait": { type: "string" },
      "min-population": { type: "string" },
      "include-visited": { type: "boolean" },
      "fake-llm": { type: "boolean" },
      cursor: { type: "string" },
      port: { type: "string" },
      "api-key": { type: "string" },
      web: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  const store = new FileStore(values.store ?? defaultStorePath());
  const countries = bundledCountries();
  const now = () => new Date().toISOString();
  const minPopulation = values["min-population"] ? Number(values["min-population"]) : DEFAULT_MIN_POPULATION;

  switch (command) {
    case "pick": {
      if (!arg) fail("pick needs an address");
      if (!values["fake-llm"])
        fail("the Bedrock classifier isn't built yet (TASKS.md T3.9); pass --fake-llm");
      let session;
      try {
        session = await startPick(
          nominatimFromEnv(),
          store,
          {
            address: arg,
            radius_m: values.radius ? Number(values.radius) : DEFAULT_RADIUS_M,
            min_population: minPopulation,
            include_visited: values["include-visited"] ?? false,
            max_wait_min: values["max-wait"] ? Number(values["max-wait"]) : undefined,
          },
          newPickId(),
          now(),
        );
      } catch (e) {
        if (e instanceof InvalidRequest || e instanceof AddressNotFound) fail(e.message);
        if (e instanceof AmbiguousAddress) {
          fail(
            `"${arg}" matches ${e.matches.length} places; add the suburb or city:\n` +
              e.matches.map((m) => `  - ${m.display_name}`).join("\n"),
          );
        }
        throw e;
      }
      process.stdout.write(`📍 ${session.location.display_name}\n`);
      const deps = {
        races: new TabNz(identityFromEnv()),
        places: new Overpass(),
        classifier: new FakeClassifier(),
        store,
        countries,
        config: defaultConfig(),
      };
      const printer = new render.Printer(countries);
      const done = await runPick(deps, session, systemClock, systemRng, (s) => printer.update(s));
      process.stdout.write(render.summary(done, countries));
      if (done.status === "failed") process.exit(1);
      return;
    }
    case "visit": {
      if (!arg) fail("visit needs a restaurant id");
      try {
        process.stdout.write(render.restaurant(await recordVisit(store, arg, null, now()), countries));
      } catch (e) {
        if (e instanceof NotFoundError)
          fail(`${arg} isn't a stored restaurant; only picked restaurants can be visited from the CLI`);
        throw e;
      }
      return;
    }
    case "skip":
      if (!arg) fail("skip needs a restaurant id");
      process.stdout.write(render.restaurant(await recordSkip(store, arg, now()), countries));
      return;
    case "passport":
      process.stdout.write(render.passport(countries, await store.countryVisits(), minPopulation));
      return;
    case "history":
      process.stdout.write(
        render.history(await store.history(values.cursor ?? null, HISTORY_PAGE), countries),
      );
      return;
    case "serve": {
      const key = values["api-key"] ?? process.env.FAT_HORSES_API_KEY;
      if (!key) fail("serve needs --api-key or FAT_HORSES_API_KEY");
      serve(
        store,
        values.port ? Number(values.port) : 8080,
        key,
        values.web ? resolve(values.web) : undefined,
      );
      return;
    }
    default:
      fail(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
