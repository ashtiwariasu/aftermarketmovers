type PipelineResult = Awaited<
  ReturnType<(typeof import("../src/lib/newsPipeline"))["runNewsPipeline"]>
>;

function summary(result: PipelineResult) {
  return {
    acquired: result.acquired,
    status: result.run.status,
    candidates: result.run.candidates,
    observations: result.run.observations,
    accepted: result.run.accepted,
    rejected: result.run.rejected,
    persisted: result.run.persisted,
    eventsUpdated: result.run.eventsUpdated,
    deduplicated: result.run.deduplicated,
    providers: result.run.providerResults,
    errors: result.run.errors,
    warnings: result.run.warnings,
  };
}

async function main() {
  process.env.DESK_STORE = process.env.DESK_STORE || "memory";
  const { runNewsPipeline } = await import("../src/lib/newsPipeline");
  const ticker = (process.argv[2] ?? "AAPL").toUpperCase();
  const repeat = process.argv.includes("--repeat");
  const first = await runNewsPipeline({ tickers: [ticker], lookbackHours: 13, concurrency: 1 });
  const output: Record<string, unknown> = { first: summary(first) };
  if (repeat) {
    const second = await runNewsPipeline({ tickers: [ticker], lookbackHours: 13, concurrency: 1 });
    output.second = summary(second);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const keepAlive = setInterval(() => {}, 1_000);
main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
