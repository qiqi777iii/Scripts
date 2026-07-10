import {
  Button,
  Group,
  HStack,
  Image,
  List,
  Menu,
  Picker,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "scripting"

import { LANGUAGE_OPTIONS } from "../constants"
import type { AppStoreInfo, ParsedAppStoreUrl } from "../utils/itunes"
import { getAppInfo } from "../utils/itunes"
import {
  getDefaultTargetLanguageCode,
  getUsableEngines,
  loadPreferredEngineId,
  savePreferredEngineId,
  translateTextWithEngine,
} from "../utils/app_store_translation"

type SectionKey = "releaseNotes" | "description"

type TranslationState = {
  selectedEngineId: string
  translatedText: string
  errorText: string
  isTranslating: boolean
}

type AppStoreTranslateViewProps = {
  parsed: ParsedAppStoreUrl
  originalInput?: string
}

function formatDate(value: string) {
  if (!value) return ""
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleDateString()
  } catch {
    return value
  }
}

function formatSize(bytes: string) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ""
  const mb = value / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

function languageLabel(code: string) {
  const option = LANGUAGE_OPTIONS.find((item) => item.code === code) ?? LANGUAGE_OPTIONS[0]
  return `${option.label}-${option.promptName}`
}

function textPreview(text: string, limit = 600) {
  const normalized = String(text ?? "").trim()
  if (!normalized) return "暂无内容"
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit)}...`
}

function withHaptic(action: () => void | Promise<void>) {
  return () => {
    try {
      HapticFeedback.lightImpact()
    } catch {}
    void action()
  }
}

function CopyableText(props: {
  text: string
  emptyText?: string
  foregroundStyle?: any
  lineLimit?: number
}) {
  const text = String(props.text ?? "")
  const hasText = text.trim().length > 0
  return (
    <Text
      foregroundStyle={props.foregroundStyle}
      lineLimit={props.lineLimit}
      truncationMode="tail"
      selectionDisabled={false}
      frame={{ maxWidth: "infinity", alignment: "leading" as any }}
      multilineTextAlignment="leading"
      onTapGesture={hasText ? withHaptic(async () => {
        await Pasteboard.setString(text)
      }) : undefined}
      contextMenu={hasText ? {
        menuItems: (
          <Button
            title="复制"
            systemImage="doc.on.doc"
            action={withHaptic(async () => {
              await Pasteboard.setString(text)
            })}
          />
        ),
      } : undefined}
    >
      {hasText ? text : (props.emptyText ?? "")}
    </Text>
  )
}

function EngineMenu(props: {
  value: string
  engines: ReturnType<typeof getUsableEngines>
  onChanged: (value: string) => void
}) {
  const selected = props.engines.find((engine) => engine.id === props.value) ?? props.engines[0]
  return (
    <Menu
      label={
        <HStack spacing={4}>
          <Image
            systemName={selected?.systemImage ?? "translate"}
            foregroundStyle="accentColor"
            font="caption"
          />
          <Text foregroundStyle="accentColor" lineLimit={1}>
            {selected?.label ?? "无可用引擎"}
          </Text>
          <Image
            systemName="chevron.down"
            font="caption2"
            foregroundStyle="accentColor"
          />
        </HStack>
      }
    >
      <Picker
        title="翻译引擎"
        value={props.value}
        onChanged={props.onChanged}
      >
        {props.engines.map((engine) => (
          <Text key={engine.id} tag={engine.id}>
            {engine.label}
          </Text>
        ))}
      </Picker>
    </Menu>
  )
}

function TargetLanguageMenu(props: {
  value: string
  onChanged: (value: string) => void
}) {
  return (
    <Menu
      label={
        <HStack spacing={4}>
          <Text foregroundStyle="accentColor" lineLimit={1}>
            {languageLabel(props.value)}
          </Text>
          <Image
            systemName="chevron.down"
            font="caption2"
            foregroundStyle="accentColor"
          />
        </HStack>
      }
    >
      <Picker
        title="目标语言"
        value={props.value}
        onChanged={props.onChanged}
      >
        {LANGUAGE_OPTIONS.map((option) => (
          <Text key={option.code} tag={option.code}>
            {languageLabel(option.code)}
          </Text>
        ))}
      </Picker>
    </Menu>
  )
}

export function AppStoreTranslateView(props: AppStoreTranslateViewProps) {
  const [appInfo, setAppInfo] = useState<AppStoreInfo | null>(null)
  const [errorText, setErrorText] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [targetLanguageCode, setTargetLanguageCode] = useState(() => getDefaultTargetLanguageCode())
  const [engines] = useState(() => getUsableEngines())
  const [systemTranslationHost] = useState(() => new Translation())
  const autoTranslateKeyRef = useRef("")
  const firstEngineId = engines[0]?.id ?? ""
  const [sections, setSections] = useState<Record<SectionKey, TranslationState>>(() => ({
    releaseNotes: {
      selectedEngineId: loadPreferredEngineId("releaseNotes") || firstEngineId,
      translatedText: "",
      errorText: "",
      isTranslating: false,
    },
    description: {
      selectedEngineId: loadPreferredEngineId("description") || firstEngineId,
      translatedText: "",
      errorText: "",
      isTranslating: false,
    },
  }))

  const updateSection = (key: SectionKey, patch: Partial<TranslationState>) => {
    setSections((current) => ({
      ...current,
      [key]: {
        ...current[key],
        ...patch,
      },
    }))
  }

  const translateSection = useEffectEvent(async (key: SectionKey, sourceText: string, explicitEngineId?: string) => {
    const text = String(sourceText ?? "").trim()
    if (!text) {
      updateSection(key, {
        translatedText: "",
        errorText: "这一段没有可翻译内容。",
        isTranslating: false,
      })
      return
    }

    const engineId = explicitEngineId || sections[key].selectedEngineId || firstEngineId
    const engine = engines.find((item) => item.id === engineId) ?? engines[0]
    if (!engine) {
      updateSection(key, {
        translatedText: "",
        errorText: "没有启用且可用的翻译引擎。",
        isTranslating: false,
      })
      return
    }

    savePreferredEngineId(key, engine.id)
    updateSection(key, {
      selectedEngineId: engine.id,
      translatedText: "",
      errorText: "",
      isTranslating: true,
    })

    try {
      const result = await translateTextWithEngine(engine, text, targetLanguageCode, systemTranslationHost)
      updateSection(key, {
        translatedText: result.translatedText,
        errorText: "",
        isTranslating: false,
      })
      try {
        HapticFeedback.notificationSuccess()
      } catch {}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateSection(key, {
        translatedText: "",
        errorText: message,
        isTranslating: false,
      })
      try {
        HapticFeedback.notificationError()
      } catch {}
    }
  })

  const loadApp = useEffectEvent(async () => {
    setIsLoading(true)
    setErrorText("")
    setAppInfo(null)
    autoTranslateKeyRef.current = ""
    try {
      const info = await getAppInfo(props.parsed.appId, props.parsed.region)
      setAppInfo(info)
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
    } finally {
      setIsLoading(false)
    }
  })

  useEffect(() => {
    void loadApp()
  }, [loadApp, props.parsed.appId, props.parsed.region])

  useEffect(() => {
    if (!appInfo || !engines.length) return

    const autoKey = [
      appInfo.trackId,
      appInfo.version,
      targetLanguageCode,
      sections.releaseNotes.selectedEngineId,
      sections.description.selectedEngineId,
    ].join("::")

    if (autoTranslateKeyRef.current === autoKey) return
    autoTranslateKeyRef.current = autoKey

    if (appInfo.releaseNotes.trim()) {
      void translateSection("releaseNotes", appInfo.releaseNotes)
    }

    if (appInfo.description.trim()) {
      void translateSection("description", appInfo.description)
    }
  }, [appInfo, engines.length, sections.releaseNotes.selectedEngineId, sections.description.selectedEngineId, targetLanguageCode, translateSection])

  const renderTranslationSection = (key: SectionKey, title: string, sourceText: string) => {
    const state = sections[key]
    return (
      <Section
        header={
          <HStack spacing={8}>
            <Text>{title}</Text>
            <Spacer />
            <EngineMenu
              value={state.selectedEngineId}
              engines={engines}
              onChanged={(value) => {
                updateSection(key, { selectedEngineId: value })
                savePreferredEngineId(key, value)
                void translateSection(key, sourceText, value)
              }}
            />
          </HStack>
        }
      >
        <CopyableText text={textPreview(sourceText)} foregroundStyle="secondaryLabel" />
        {state.isTranslating ? (
          <VStack spacing={10} frame={{ maxWidth: "infinity", alignment: "center" as any }}>
            <ProgressView />
          </VStack>
        ) : state.translatedText ? (
          <CopyableText text={state.translatedText} />
        ) : (
          <CopyableText
            text=""
            emptyText={state.errorText || "点“翻译”开始翻译这一段。"}
            foregroundStyle={state.errorText ? "systemRed" : "secondaryLabel"}
          />
        )}
      </Section>
    )
  }

  return (
    <List
      navigationTitle="App Store 翻译"
      navigationBarTitleDisplayMode="inline"
      listStyle="insetGroup"
      translationHost={systemTranslationHost}
    >
      <Section header={<Text>目标语言</Text>}>
        <HStack spacing={12}>
          <Text>翻译为</Text>
          <Spacer />
          <TargetLanguageMenu
            value={targetLanguageCode}
            onChanged={(value) => {
              setTargetLanguageCode(value)
            }}
          />
        </HStack>
      </Section>

      {isLoading ? (
        <Section>
          <VStack spacing={10} frame={{ maxWidth: "infinity", alignment: "center" as any }}>
            <ProgressView />
            <Text foregroundStyle="secondaryLabel">正在读取 App Store 信息...</Text>
          </VStack>
        </Section>
      ) : errorText ? (
        <Section>
          <Text foregroundStyle="systemRed">{errorText}</Text>
          <CopyableText text={props.originalInput ?? ""} foregroundStyle="secondaryLabel" />
          <Button
            title="重试"
            systemImage="arrow.clockwise"
            action={() => {
              void loadApp()
            }}
          />
        </Section>
      ) : appInfo ? (
        <Group>
          <Section header={<Text>应用信息</Text>}>
            <Text font="headline">{appInfo.trackName}</Text>
            <Text foregroundStyle="secondaryLabel">{appInfo.artistName || appInfo.sellerName}</Text>
            <HStack>
              <Text>版本</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{appInfo.version || "-"}</Text>
            </HStack>
            <HStack>
              <Text>更新时间</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{formatDate(appInfo.currentVersionReleaseDate) || "-"}</Text>
            </HStack>
            <HStack>
              <Text>地区</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{props.parsed.region.toUpperCase()}</Text>
            </HStack>
            <HStack>
              <Text>包名</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel" lineLimit={1} truncationMode="middle">
                {appInfo.bundleId || "-"}
              </Text>
            </HStack>
            <HStack>
              <Text>大小</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{formatSize(appInfo.fileSizeBytes) || "-"}</Text>
            </HStack>
            <HStack>
              <Text>价格</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">{appInfo.formattedPrice || "-"}</Text>
            </HStack>
          </Section>

          {engines.length === 0 ? (
            <Section>
              <Text foregroundStyle="systemRed">
                没有启用且可用的翻译引擎。请回到翻译器设置里启用至少一个引擎。
              </Text>
            </Section>
          ) : null}

          {renderTranslationSection("releaseNotes", "版本更新", appInfo.releaseNotes)}
          {renderTranslationSection("description", "应用介绍", appInfo.description)}
        </Group>
      ) : null}
    </List>
  )
}
