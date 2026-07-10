import {
  Button,
  Group,
  HStack,
  Image,
  Menu,
  List,
  Picker,
  ProgressView,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "scripting"

import { AUTO_LANGUAGE, LANGUAGE_OPTIONS } from "../constants"
import type {
  EngineTranslationState,
  LanguageOption,
  TranslatorEngineEntry,
} from "../types"
import {
  createAssistantTranslationEngine,
  isAssistantTranslationAvailable,
} from "../utils/assistant_translation_engine"
import {
  createTranslationEngine,
  isLocalTranslationAvailable,
} from "../utils/translation_engine"
import {
  isExternalEngineConfigured,
  translateWithExternalEngine,
} from "../utils/external_translation_engines"
import {
  createSystemTranslationEngine,
  isSystemTranslationAvailable,
} from "../utils/system_translation_engine"
import { finishTranslation } from "../utils/translation_session"
import {
  getExecutableEngines,
  loadTranslatorSettings,
  saveTranslatorSettings,
  updateDefaultTargetLanguage,
  updateEngineEnabled,
} from "../utils/translator_settings"

type TranslationPanelProps = {
  inputText: string | null
  allowsReplacement: boolean
}

function summarizeText(text: string, maxLength = 48) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function logTranslationEvent(message: string, payload?: Record<string, unknown>) {
  if (payload) {
    console.log(`[Translator] ${message}`, payload)
    return
  }
  console.log(`[Translator] ${message}`)
}

function assistantLogOptions(engine: { kind?: string; config?: any }) {
  if (engine.kind !== "assistant") return {}

  const providerId = String(engine.config?.assistantProviderId ?? "openai").trim() || "openai"
  const customProvider = String(engine.config?.assistantCustomProvider ?? "").trim()
  const modelId = String(engine.config?.assistantModelId ?? "").trim()

  return {
    provider: providerId === "custom" ? `{ custom: "${customProvider}" }` : providerId,
    modelId: modelId || "(default)",
  }
}

function withHaptic(action: () => void | Promise<void>) {
  return () => {
    try {
      HapticFeedback.lightImpact()
    } catch {}
    void action()
  }
}

function pickerLabel(option: LanguageOption) {
  if (option.code === AUTO_LANGUAGE.code) {
    return "自动检测-Auto"
  }

  return `${option.label}-${option.promptName}`
}

function LanguageMenu(props: {
  title: string
  value: string
  selectedLabel: string
  onChanged: (value: string) => void
  options: LanguageOption[]
  alignment?: "leading" | "trailing"
}) {
  const align = props.alignment ?? "leading"
  return (
    <Menu
      label={
        <HStack spacing={4}>
          <Text
            font="subheadline"
            foregroundStyle="secondaryLabel"
            lineLimit={1}
            truncationMode="tail"
            allowsTightening
            frame={{ maxWidth: 150, alignment: align as any }}
            multilineTextAlignment={align}
          >
            {props.selectedLabel}
          </Text>
          <Image
            systemName="chevron.down"
            font="caption2"
            foregroundStyle="tertiaryLabel"
          />
        </HStack>
      }
    >
      <Picker
        title={props.title}
        value={props.value}
        onChanged={props.onChanged}
      >
        {props.options.map((option) => (
          <Text key={option.code} tag={option.code}>
            {pickerLabel(option)}
          </Text>
        ))}
      </Picker>
    </Menu>
  )
}

function CopyableTextRow(props: {
  text: string
  emptyText?: string
  foregroundStyle?: any
  lineLimit?: number
  extraMenuButtons?: Array<{
    title: string
    systemImage: string
    action: () => void | Promise<void>
  }>
  canReplace?: boolean
  onTapWhenEmpty?: () => void | Promise<void>
  onRetranslate?: () => void | Promise<void>
  onReplace?: () => void | Promise<void>
}) {
  const hasText = props.text.trim().length > 0
  const hasMenu = hasText || !!props.onRetranslate || (!!props.onReplace && !!props.canReplace) || !!props.extraMenuButtons?.length
  const copyAction = withHaptic(async () => {
    if (!hasText) return
    await Pasteboard.setString(props.text)
    try {
      HapticFeedback.notificationSuccess()
    } catch {}
  })
  const emptyTapAction = props.onTapWhenEmpty ? withHaptic(props.onTapWhenEmpty) : undefined

  return (
    <Text
      onTapGesture={hasText ? copyAction : emptyTapAction}
      contextMenu={hasMenu ? {
        menuItems: (
          <Group>
            {hasText ? (
              <Button
                title="复制"
                systemImage="doc.on.doc"
                action={withHaptic(async () => {
                  await Pasteboard.setString(props.text)
                })}
              />
            ) : null}
            {props.onRetranslate ? (
              <Button
                title="重译"
                systemImage="arrow.clockwise"
                action={withHaptic(props.onRetranslate)}
              />
            ) : null}
            {props.onReplace ? (
              <Button
                title="替换原文"
                systemImage="rectangle.and.pencil.and.ellipsis"
                disabled={!props.canReplace}
                action={withHaptic(props.onReplace)}
              />
            ) : null}
            {props.extraMenuButtons?.map((item) => (
              <Button
                key={`${item.title}-${item.systemImage}`}
                title={item.title}
                systemImage={item.systemImage}
                action={withHaptic(item.action)}
              />
            ))}
          </Group>
        ),
      } : undefined}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      contentShape={{
        kind: "interaction",
        shape: "rect",
      }}
      multilineTextAlignment="leading"
      selectionDisabled={false}
      foregroundStyle={props.foregroundStyle}
      lineLimit={props.lineLimit}
      truncationMode="tail"
    >
      {hasText ? props.text : (props.emptyText || "")}
    </Text>
  )
}

function splitComparableUnits(text: string) {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
  if (!normalized) return []

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length > 1) return lines

  const units: string[] = []
  let buffer = ""
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    buffer += char
    if (!/[.!?。！？；;]/.test(char)) continue

    const nextChar = normalized[index + 1] ?? ""
    if (nextChar && !/\s/.test(nextChar)) continue

    const unit = buffer.trim()
    if (unit) units.push(unit)
    buffer = ""
  }

  const tail = buffer.trim()
  if (tail) units.push(tail)
  return units.length ? units : [normalized]
}

function createCompareTranslationText(sourceText: string, translatedText: string) {
  const sourceUnits = splitComparableUnits(sourceText)
  const translatedUnits = splitComparableUnits(translatedText)
  const count = Math.max(sourceUnits.length, translatedUnits.length)
  const blocks: string[] = []

  for (let index = 0; index < count; index += 1) {
    const source = sourceUnits[index]
    const translated = translatedUnits[index]
    if (source) blocks.push(source)
    if (translated) blocks.push(translated)
    if (index < count - 1) blocks.push("")
  }

  return blocks.join("\n")
}

function isEngineAvailable(engine: TranslatorEngineEntry) {
  if (engine.kind === "apple_intelligence") {
    return isLocalTranslationAvailable()
  }

  if (engine.kind === "assistant") {
    return isAssistantTranslationAvailable()
  }

  if (engine.kind === "system_translation") {
    return isSystemTranslationAvailable()
  }

  return isExternalEngineConfigured(engine)
}

export function TranslationPanel(props: TranslationPanelProps) {
  const sourceText = props.inputText ?? ""
  const hasInput = sourceText.trim().length > 0
  const [settings, setSettings] = useState(() => loadTranslatorSettings())
  const [sourceLanguageCode, setSourceLanguageCode] = useState(() => settings.defaultSourceLanguageCode)
  const [targetLanguageCode, setTargetLanguageCode] = useState(() => settings.defaultTargetLanguageCode)
  const [systemTranslationHost] = useState(() => new Translation())
  const [errorText, setErrorText] = useState("")
  const [engineResults, setEngineResults] = useState<EngineTranslationState[]>([])
  const [isCompareMode, setIsCompareMode] = useState(true)
  const requestIdRef = useRef(0)
  const targetTouchedRef = useRef(false)
  const executableEngines = getExecutableEngines(settings)
  const assistantConfig = settings.engines.find((engine) => engine.kind === "assistant")?.config
  const [appleEngine] = useState(() => createTranslationEngine())
  const [assistantEngine] = useState(() => createAssistantTranslationEngine(assistantConfig))
  const [systemEngine] = useState(() => createSystemTranslationEngine(systemTranslationHost))

  const visibleEngines = executableEngines.filter((engine) => engine.enabled && isEngineAvailable(engine))

  function createLoadingStates(): EngineTranslationState[] {
    return visibleEngines.map((engine) => ({
      engineId: engine.id,
      engineName: engine.label,
      systemImage: engine.systemImage,
      translatedText: "",
      errorText: "",
      isTranslating: true,
    }))
  }

  async function translateEngine(engine: typeof visibleEngines[number]) {
    const request = {
      sourceText,
      sourceLanguageCode,
      targetLanguageCode,
    }

    const result = engine.kind === "apple_intelligence"
      ? await appleEngine.translate(request)
      : engine.kind === "assistant"
        ? await assistantEngine.translate(request)
      : engine.kind === "system_translation"
        ? await systemEngine.translate(request)
        : await translateWithExternalEngine(engine, request)

    return {
      engineId: engine.id,
      engineName: engine.label,
      systemImage: engine.systemImage,
      translatedText: result.translatedText,
      errorText: "",
      isTranslating: false,
    } satisfies EngineTranslationState
  }

  useEffect(() => {
    appleEngine.prewarm()
    return () => {
      appleEngine.dispose()
    }
  }, [appleEngine])

  const runTranslation = useEffectEvent(async () => {
    if (!hasInput) return

    if (!visibleEngines.length) {
      logTranslationEvent("没有可执行的翻译引擎", {
        sourceLanguageCode,
        targetLanguageCode,
      })
      setEngineResults([])
      setErrorText("没有启用且可用的翻译引擎。")
      return
    }

    if (
      sourceLanguageCode !== AUTO_LANGUAGE.code &&
      sourceLanguageCode === targetLanguageCode
    ) {
      logTranslationEvent("源语言和目标语言相同，已拦截翻译", {
        sourceLanguageCode,
        targetLanguageCode,
      })
      setEngineResults(visibleEngines.map((engine) => ({
        engineId: engine.id,
        engineName: engine.label,
        systemImage: engine.systemImage,
        translatedText: "",
        errorText: "源语言和目标语言不能相同。",
        isTranslating: false,
      })))
      setErrorText("源语言和目标语言不能相同。")
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const startedAt = Date.now()
    setErrorText("")
    setEngineResults(createLoadingStates())
    logTranslationEvent("开始翻译", {
      requestId,
      sourceLength: sourceText.length,
      sourcePreview: summarizeText(sourceText),
      sourceLanguageCode,
      targetLanguageCode,
      engines: visibleEngines.map((engine) => ({
        engineName: engine.label,
        ...assistantLogOptions(engine),
      })),
    })

    try {
      // 这里逐条回填每个引擎的状态，不再在最后整体覆盖，避免未完成项丢掉自己的加载态。
      await Promise.allSettled(
        visibleEngines.map(async (engine) => {
          const engineStartedAt = Date.now()
          logTranslationEvent("引擎开始翻译", {
            requestId,
            engineId: engine.id,
            engineName: engine.label,
            ...assistantLogOptions(engine),
          })
          try {
            const result = await translateEngine(engine)
            if (requestId !== requestIdRef.current) return null
            logTranslationEvent("引擎翻译成功", {
              requestId,
              engineId: engine.id,
              engineName: engine.label,
              ...assistantLogOptions(engine),
              elapsedMs: Date.now() - engineStartedAt,
              translatedLength: result.translatedText.length,
              translatedPreview: summarizeText(result.translatedText),
            })

            setEngineResults((current) => current.map((item) => (
              item.engineId === engine.id ? result : item
            )))
            return result
          } catch (error) {
            if (requestId !== requestIdRef.current) return null
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[Translator] 引擎翻译失败`, {
              requestId,
              engineId: engine.id,
              engineName: engine.label,
              ...assistantLogOptions(engine),
              elapsedMs: Date.now() - engineStartedAt,
              error: message,
            })

            const failed = {
              engineId: engine.id,
              engineName: engine.label,
              systemImage: engine.systemImage,
              translatedText: "",
              errorText: message,
              isTranslating: false,
            } satisfies EngineTranslationState
            setEngineResults((current) => current.map((item) => (
              item.engineId === engine.id ? failed : item
            )))
            return failed
          }
        })
      )

      if (requestId !== requestIdRef.current) return
      logTranslationEvent("翻译完成", {
        requestId,
        elapsedMs: Date.now() - startedAt,
      })
      try {
        HapticFeedback.notificationSuccess()
      } catch {}
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[Translator] 翻译流程失败`, {
        requestId,
        elapsedMs: Date.now() - startedAt,
        error: message,
      })
      setErrorText(message)
      try {
        HapticFeedback.notificationError()
      } catch {}
    }
  })

  useEffect(() => {
    if (!hasInput) return
    void runTranslation()
  }, [hasInput, runTranslation, sourceLanguageCode, sourceText, targetLanguageCode, settings])

  useEffect(() => {
    targetTouchedRef.current = false
  }, [sourceText])

  // 保持用户选择/记住的目标语言，不再根据检测结果自动改目标语言。
  // TestFlight 分享文本常混有中文界面标签和英文测试内容，自动改目标语言会造成先中译、再英译的二次翻译。

  const selectSourceLanguage = useEffectEvent((code: string) => {
    setSourceLanguageCode(code)
    setErrorText("")
  })

  const selectTargetLanguage = useEffectEvent((code: string) => {
    targetTouchedRef.current = true
    setTargetLanguageCode(code)
    const nextSettings = updateDefaultTargetLanguage(loadTranslatorSettings(), code)
    saveTranslatorSettings(nextSettings)
    setSettings(nextSettings)
    setErrorText("")
  })

  const useTranslation = useEffectEvent(async (translatedText: string) => {
    if (!translatedText || !props.allowsReplacement) return
    finishTranslation(translatedText)
  })

  const rerunAllTranslations = useEffectEvent(async () => {
    await runTranslation()
  })

  const toggleCompareMode = useEffectEvent(() => {
    setIsCompareMode((current) => !current)
  })

  const toggleEngine = useEffectEvent((engineId: string, enabled: boolean) => {
    const nextSettings = updateEngineEnabled(loadTranslatorSettings(), engineId, enabled)
    saveTranslatorSettings(nextSettings)
    setSettings(nextSettings)
    requestIdRef.current += 1
    setEngineResults((current) => current.filter((item) => (
      nextSettings.engines.some((engine) => engine.id === item.engineId && engine.enabled)
    )))
    setErrorText("")
  })

  const rerunSingleEngine = useEffectEvent(async (engineId: string) => {
    const engine = visibleEngines.find((item) => item.id === engineId)
    if (!engine || !hasInput) return

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const startedAt = Date.now()
    setErrorText("")
    setEngineResults((current) => current.map((item) => (
      item.engineId === engineId
        ? {
            ...item,
            isTranslating: true,
            errorText: "",
          }
        : item
    )))
    logTranslationEvent("单引擎重试开始", {
      requestId,
      engineId: engine.id,
      engineName: engine.label,
      ...assistantLogOptions(engine),
      sourceLanguageCode,
      targetLanguageCode,
    })

    try {
      const result = await translateEngine(engine)
      if (requestId !== requestIdRef.current) return
      logTranslationEvent("单引擎重试成功", {
        requestId,
        engineId: engine.id,
        engineName: engine.label,
        ...assistantLogOptions(engine),
        elapsedMs: Date.now() - startedAt,
        translatedLength: result.translatedText.length,
        translatedPreview: summarizeText(result.translatedText),
      })

      setEngineResults((current) => current.map((item) => (
        item.engineId === engineId ? result : item
      )))
      try {
        HapticFeedback.notificationSuccess()
      } catch {}
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[Translator] 单引擎重试失败`, {
        requestId,
        engineId: engine.id,
        engineName: engine.label,
        ...assistantLogOptions(engine),
        elapsedMs: Date.now() - startedAt,
        error: message,
      })

      setEngineResults((current) => current.map((item) => (
        item.engineId === engineId
          ? {
              ...item,
              translatedText: "",
              errorText: message,
              isTranslating: false,
            }
          : item
      )))
      try {
        HapticFeedback.notificationError()
      } catch {}
    }
  })

  if (!hasInput) {
    return (
      <List
        listStyle="insetGroup"
        scrollContentBackground="hidden"
        contentMargins={{
          edges: "top",
          insets: 0,
          placement: "scrollContent",
        }}
        presentationDetents={["medium", "large"]}
        presentationDragIndicator="visible"
        presentationContentInteraction="resizes"
        translationHost={systemTranslationHost}
      >
        <Section>
          <Text foregroundStyle="secondaryLabel">
            当前宿主没有传入可供翻译的文本。
          </Text>
        </Section>
      </List>
    )
  }

  return (
    <List
      listStyle="insetGroup"
      scrollContentBackground="hidden"
      contentMargins={{
        edges: "top",
        insets: 0,
        placement: "scrollContent",
      }}
      presentationDetents={["medium", "large"]}
      presentationDragIndicator="visible"
      presentationContentInteraction="resizes"
      translationHost={systemTranslationHost}
    >
      <Section>
        <HStack spacing={6}>
          <LanguageMenu
            title="源语言"
            value={sourceLanguageCode}
            selectedLabel={sourceLanguageCode === AUTO_LANGUAGE.code
              ? pickerLabel(AUTO_LANGUAGE)
              : pickerLabel([AUTO_LANGUAGE, ...LANGUAGE_OPTIONS].find((option) => option.code === sourceLanguageCode) ?? AUTO_LANGUAGE)}
            onChanged={selectSourceLanguage}
            options={[AUTO_LANGUAGE, ...LANGUAGE_OPTIONS]}
          />
          <Image
            systemName="arrow.right"
            font="caption"
            foregroundStyle="tertiaryLabel"
          />
          <LanguageMenu
            title="目标语言"
            value={targetLanguageCode}
            selectedLabel={pickerLabel(LANGUAGE_OPTIONS.find((option) => option.code === targetLanguageCode) ?? LANGUAGE_OPTIONS[0])}
            onChanged={selectTargetLanguage}
            options={LANGUAGE_OPTIONS}
          />
        </HStack>
        <Menu
          label={
            <HStack spacing={8}>
              <Image
                systemName="line.3.horizontal"
                foregroundStyle="systemBlue"
              />
              <Text foregroundStyle="systemBlue">
                翻译选项
              </Text>
            </HStack>
          }
        >
          <Button
            title={isCompareMode ? "关闭对比翻译" : "开启对比翻译"}
            systemImage={isCompareMode ? "text.justify.left" : "text.alignleft"}
            action={withHaptic(toggleCompareMode)}
          />
          {settings.engines.map((engine) => {
            const available = isEngineAvailable(engine)
            return (
              <Toggle
                key={engine.id}
                title={engine.label}
                systemImage={engine.systemImage}
                value={engine.enabled && available}
                disabled={!available}
                onChanged={(value: boolean) => toggleEngine(engine.id, value)}
              />
            )
          })}
        </Menu>
      </Section>

      {visibleEngines.length === 0 ? (
        <Section>
          <Text foregroundStyle="secondaryLabel">
            {errorText || "没有启用且可用的翻译引擎。"}
          </Text>
        </Section>
      ) : (
        engineResults.map((result) => (
          <Section
            key={result.engineId}
            header={
              <HStack spacing={8}>
                <Image
                  systemName={result.systemImage}
                  font="caption"
                  foregroundStyle="secondaryLabel"
                />
                <Text
                  font="subheadline"
                  foregroundStyle="secondaryLabel"
                >
                  {result.engineName}
                </Text>
              </HStack>
            }
          >
            {result.isTranslating ? (
              <VStack spacing={10} frame={{ maxWidth: "infinity", alignment: "center" as any }}>
                <ProgressView />
              </VStack>
            ) : result.translatedText ? (
              <CopyableTextRow
                text={isCompareMode ? createCompareTranslationText(sourceText, result.translatedText) : result.translatedText}
                canReplace={props.allowsReplacement}
                onRetranslate={rerunAllTranslations}
                onReplace={() => useTranslation(result.translatedText)}
              />
            ) : (
              <CopyableTextRow
                text=""
                emptyText={result.errorText || errorText || "暂无译文"}
                foregroundStyle={(result.errorText || errorText) ? "systemRed" : "secondaryLabel"}
                onTapWhenEmpty={() => rerunSingleEngine(result.engineId)}
                onRetranslate={rerunAllTranslations}
              />
            )}
          </Section>
        ))
      )}
    </List>
  )
}
