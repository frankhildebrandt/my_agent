import { FileSettingsRepository } from "./infrastructure/settings/FileSettingsRepository";
import { SettingsMigrationService } from "./infrastructure/settings/SettingsMigrationService";

export interface AppSettings {
  commands: {
    prefix: string;
  };
  chat: {
    inputLabel: string;
    welcomeMessage: string;
  };
  editor: {
    command: string;
  };
  files: {
    settingsPath: string;
  };
  llm: {
    defaultModel: string;
    requestTimeoutMs: number;
    systemPrompt: string;
    providers: Record<string, ProviderConfig>;
    models: Record<string, ModelConfig>;
  };
  memory: {
    shortTerm: {
      mode: "buffer" | "conversation" | "hybrid";
      maxTotalChars: number;
      persistPath: string;
    };
    midTerm: {
      dir: string;
      indexPath: string;
      topK: number;
      maxFragmentChars: number;
      maxTotalChars: number;
      maxFragmentsPerSleep: number;
      maxEntries: number;
    };
    longTerm: {
      dir: string;
      indexPath: string;
      topK: number;
      maxFragmentChars: number;
      maxTotalChars: number;
      maxFragmentsPerSleep: number;
    };
  };
  modules: {
    dir: string;
    policyPath: string;
    socketTimeoutMs: number;
    startupTimeoutMs: number;
    discoveryTopK: number;
    maxPromptModules: number;
    autoStartOnCall: boolean;
    includeModuleDetailsInPrompt: boolean;
    maxResponseBytes: number;
  };
  controlSocket: {
    path: string;
    maxQueuedRequests: number;
    requestTimeoutMs: number;
  };
  scriptRegistry: {
    path: string;
    indexPath: string;
    topK: number;
    embeddings: {
      provider: string;
      model: string;
      requestTimeoutMs: number;
    };
  };
  tools: {
    enabled: boolean;
    executionTimeoutMs: number;
    maxRoundtrips: number;
    scriptsDir: string;
  };
  ui: {
    title: string;
  };
}

export interface ProviderConfig {
  type: "openai-compatible";
  baseUrl: string;
  apiKeyEnv: string;
  defaultHeaders?: Record<string, string>;
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export const defaultSettings: AppSettings = {
  commands: {
    prefix: "/",
  },
  chat: {
    inputLabel: "Prompt",
    welcomeMessage:
      "Chat initialisiert. Commands starten mit '/'. Verfuegbar: /help, /new, /usage, /credits, /settings, /models, /use <alias>, /debug, /reset, /sleep, /sleepquiet, /memoryroundup, /memoryreset, /quit. Tool-Loop fuer agent_scripts ist aktiv.",
  },
  editor: {
    command: "default",
  },
  files: {
    settingsPath: "settings.json",
  },
  llm: {
    defaultModel: "openai-default",
    requestTimeoutMs: 90_000,
    systemPrompt: "Du bist ein pragmatischer, deutschsprachiger Assistent. Antworte knapp und technisch sauber.",
    providers: {
      openai: {
        type: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      openrouter: {
        type: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        defaultHeaders: {
          "HTTP-Referer": "http://localhost/my_agent",
          "X-Title": "my_agent",
        },
      },
    },
    models: {
      "openai-default": {
        provider: "openai",
        model: "gpt-5-mini",
        temperature: 0.2,
        maxTokens: 1200,
      },
      "openrouter-default": {
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        temperature: 0.2,
        maxTokens: 1200,
      },
    },
  },
  tools: {
    enabled: true,
    executionTimeoutMs: 30_000,
    maxRoundtrips: 8,
    scriptsDir: "./agent_scripts",
  },
  memory: {
    shortTerm: {
      mode: "hybrid",
      maxTotalChars: 4000,
      persistPath: "./agent_memory/short_term_memory.json",
    },
    midTerm: {
      dir: "./agent_memory/mid_term_memory",
      indexPath: "./agent_memory/mid_term_index",
      topK: 6,
      maxFragmentChars: 900,
      maxTotalChars: 3500,
      maxFragmentsPerSleep: 10,
      maxEntries: 24,
    },
    longTerm: {
      dir: "./agent_memory/long_term_memory",
      indexPath: "./agent_memory/long_term_index",
      topK: 5,
      maxFragmentChars: 1000,
      maxTotalChars: 4000,
      maxFragmentsPerSleep: 8,
    },
  },
  modules: {
    dir: "./agent_modules",
    policyPath: "./agent_modules/policy.json",
    socketTimeoutMs: 8_000,
    startupTimeoutMs: 20_000,
    discoveryTopK: 5,
    maxPromptModules: 3,
    autoStartOnCall: true,
    includeModuleDetailsInPrompt: false,
    maxResponseBytes: 131_072,
  },
  controlSocket: {
    path: "./agent_socket/control.sock",
    maxQueuedRequests: 8,
    requestTimeoutMs: 90_000,
  },
  scriptRegistry: {
    path: "./agent_scripts/registry.json",
    indexPath: "./agent_scripts/registry_index",
    topK: 5,
    embeddings: {
      provider: "openai",
      model: "text-embedding-3-small",
      requestTimeoutMs: 30_000,
    },
  },
  ui: {
    title: "my_agent",
  },
};

export function loadSettings(): AppSettings {
  return new FileSettingsRepository(defaultSettings, new SettingsMigrationService()).load();
}
