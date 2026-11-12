export interface RedTeamRunner {
  start(mandateId: string, agentToken: string): Promise<{ run_id: string }>;
  get(runId: string): Promise<unknown>;
}
