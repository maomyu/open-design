export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;

export interface TelemetryPrefs {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export interface OrbitConfigPrefs {
  enabled: boolean;
  /** Local 24-hour clock time in HH:mm format. Defaults to 08:00. */
  time: string;
  /** Optional skill id from the examples gallery where scenario === "orbit". */
  templateSkillId?: string | null;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  skillId?: string | null;
  designSystemId?: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  telemetry?: TelemetryPrefs;
  /**
   * Unix-millis timestamp of when the user resolved the first-run privacy
   * consent surface (Share or Decline). Set on first decision and on
   * subsequent toggles in Settings → Privacy. Independent of
   * installationId so that "Delete my data" can rotate the id without
   * re-popping the consent banner.
   */
  privacyDecisionAt?: number | null;
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
  /**
   * Locally stored third-party service API keys (e.g. TIKHUB_API_KEY for
   * trending-topic scraping). Keys must look like environment variable
   * names (`/^[A-Z][A-Z0-9_]*$/`); values are plain strings. The daemon
   * injects them into spawned agent child processes as environment
   * variables (with lower precedence than per-agent `agentCliEnv`).
   * These are secrets: never log them and never send them off-machine.
   */
  thirdPartyApiKeys?: Record<string, string>;
  /**
   * Per-plugin config values: `{ [pluginId]: { [KEY]: value } }`. A plugin
   * declares the keys it needs via `od.config` in its manifest; the operator
   * fills the values in the plugin editor. The daemon injects a plugin's own
   * map as environment variables into THAT plugin's runs only (highest
   * precedence — above global thirdPartyApiKeys), so different plugins can use
   * different credentials. Same secrecy rules as thirdPartyApiKeys: never log,
   * never send off-machine. Key names must look like env vars
   * (`/^[A-Z][A-Z0-9_]*$/`).
   */
  pluginConfig?: Record<string, Record<string, string>>;
}

export interface AppConfigResponse {
  config: AppConfigPrefs;
}

export type UpdateAppConfigRequest = Partial<AppConfigPrefs>;
