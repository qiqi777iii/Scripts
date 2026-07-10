import { AUTO_LANGUAGE } from "../constants"
import type { TranslationRequest, TranslationResult, TranslatorEngineEntry } from "../types"
import {
  createAssistantTranslationEngine,
  isAssistantTranslationAvailable,
} from "./assistant_translation_engine"
import {
  isExternalEngineConfigured,
  translateWithExternalEngine,
} from "./external_translation_engines"
import {
  createSystemTranslationEngine,
  isSystemTranslationAvailable,
} from "./system_translation_engine"
import {
  createTranslationEngine,
  isLocalTranslationAvailable,
} from "./translation_engine"
import {
  getExecutableEngines,
  loadTranslatorSettings,
} from "./translator_settings"

const PREFERRED_ENGINE_STORAGE_KEY = "app_store_translate_engine_v1"

type PreferredEngineMap = Record<string, string>

function storage() {
  return (globalThis as any).Storage
}

function isEngineAvailable(engine: TranslatorEngineEntry) {
  if (engine.kind === "apple_intelligence") return isLocalTranslationAvailable()
  if (engine.kind === "assistant") return isAssistantTranslationAvailable()
  if (engine.kind === "system_translation") return isSystemTranslationAvailable()
  return isExternalEngineConfigured(engine)
}

export function getUsableEngines() {
  const settings = loadTranslatorSettings()
  return getExecutableEngines(settings).filter((engine) => engine.enabled && isEngineAvailable(engine))
}

export function getDefaultTargetLanguageCode() {
  return loadTranslatorSettings().defaultTargetLanguageCode
}

export function loadPreferredEngineId(sectionKey: string) {
  const st = storage()
  const raw = st?.get?.(PREFERRED_ENGINE_STORAGE_KEY) as PreferredEngineMap | null | undefined
  return String(raw?.[sectionKey] ?? "")
}

export function savePreferredEngineId(sectionKey: string, engineId: string) {
  const st = storage()
  if (!st?.set) return
  const raw = st?.get?.(PREFERRED_ENGINE_STORAGE_KEY) as PreferredEngineMap | null | undefined
  st.set(PREFERRED_ENGINE_STORAGE_KEY, {
    ...(raw ?? {}),
    [sectionKey]: engineId,
  })
}

export async function translateTextWithEngine(
  engine: TranslatorEngineEntry,
  text: string,
  targetLanguageCode: string,
  systemTranslationHost?: Translation
): Promise<TranslationResult> {
  const request: TranslationRequest = {
    sourceText: text,
    sourceLanguageCode: AUTO_LANGUAGE.code,
    targetLanguageCode,
  }

  if (engine.kind === "apple_intelligence") {
    const translator = createTranslationEngine()
    try {
      return await translator.translate(request)
    } finally {
      translator.dispose()
    }
  }

  if (engine.kind === "assistant") {
    return await createAssistantTranslationEngine(engine.config).translate(request)
  }

  if (engine.kind === "system_translation") {
    const host = systemTranslationHost ?? new Translation()
    return await createSystemTranslationEngine(host).translate(request)
  }

  return await translateWithExternalEngine(engine, request)
}
