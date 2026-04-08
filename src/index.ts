import { loadSettings } from "./settings";
import { SystemClock } from "./infrastructure/system/SystemClock";
import { EditorLauncher } from "./infrastructure/system/EditorLauncher";
import { OpenAiCompatibleInferenceClient } from "./infrastructure/inference/OpenAiCompatibleInferenceClient";
import { MemoryRepository } from "./infrastructure/memory/MemoryRepository";
import { ScriptRegistryRepository } from "./infrastructure/scriptRegistry/ScriptRegistryRepository";
import { RegisteredToolExecutor, ToolRegistry } from "./tools/registry";
import { TuiChatApplication } from "./presentation/tui/TuiChatApplication";

function main(): void {
  const settings = loadSettings();
  const toolRegistry = new ToolRegistry();

  const application = new TuiChatApplication(
    settings,
    new SystemClock(),
    new EditorLauncher(),
    new OpenAiCompatibleInferenceClient(),
    new MemoryRepository(),
    new ScriptRegistryRepository(),
    new RegisteredToolExecutor(toolRegistry),
  );

  application.start();
}

main();
