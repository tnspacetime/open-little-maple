import { stringField, type JsonObject } from "../harness/json.js";
import type { TurnServicePluginDeclaration } from "../harness/load-turn-service-plugins.js";
import type { ConfigureTurnServices } from "../harness/turn-service-configuration.js";
import {
  defineTurnServicePlugin,
  type TurnServicePluginFactoryRegistration,
} from "../harness/turn-service-plugin.js";
import {
  Provider,
  defineTurnService,
} from "../harness/turn-service.js";
import { OpenAIResponsesProvider } from "./openai.js";

export const runtimePluginInstanceId = "little-maple-runtime";
export const runtimePluginFactoryId = "little-maple-runtime/v1";
export const openAIProviderKey = "openai";

export type RuntimeServicesOptions = {
  readonly model: string;
  readonly baseURL?: string;
};

export function runtimePluginFactory(
  apiKey: string,
): TurnServicePluginFactoryRegistration {
  if (!apiKey.trim()) throw new Error("OPENAI_API_KEY cannot be empty");

  return {
    id: runtimePluginFactoryId,
    factory(settings) {
      const model = stringField(settings, "model");
      const baseURL = stringField(settings, "baseURL");
      const instructions = stringArray(settings, "instructions");

      return defineTurnServicePlugin(runtimePluginInstanceId, (context) => {
        context.provide(
          defineTurnService(
            Provider,
            openAIProviderKey,
            new OpenAIResponsesProvider({ apiKey, baseURL }),
            {
              revision: "openai-responses-v1",
              settings: {
                model,
                instructions,
                metadata: {},
                baseURL,
              },
            },
          ),
        );
      });
    },
  };
}

export function runtimePluginDeclaration(
  options: RuntimeServicesOptions,
): TurnServicePluginDeclaration {
  const baseURL = options.baseURL?.trim() || "https://api.openai.com/v1";
  return {
    id: runtimePluginInstanceId,
    factory: runtimePluginFactoryId,
    settings: {
      model: options.model,
      baseURL,
      instructions: [
        "You are a coding assistant.",
        "Continue after tool results until the user's task is complete.",
      ],
    },
  };
}

function stringArray(value: JsonObject, key: string): readonly string[] {
  const candidate = value[key];
  if (
    !Array.isArray(candidate) ||
    candidate.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${key} must be an array of nonempty strings`);
  }
  return Object.freeze([...(candidate as string[])]);
}

/** New Sessions start with a Provider and no implicit Location or Tools. */
export const configureDefaultTurnServices = (
  selection: Parameters<ConfigureTurnServices>[0],
): void => {
  selection.include(Provider, openAIProviderKey);
};
