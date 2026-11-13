export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnvironmentSafety } = await import("@/lib/environment");
    const report = assertEnvironmentSafety();
    console.info(
      `[environment] ${report.environment} project=${report.projectId || "local"} data=${report.dataMode} email=${report.emailMode} billing=${report.billingMode}`,
    );
  }
}
