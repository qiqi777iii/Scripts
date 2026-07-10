import {
  Intent,
  Navigation,
  NavigationStack,
  Script,
  Section,
  Text,
  List,
} from "scripting"

import { AppStoreTranslateView } from "./components/AppStoreTranslateView"
import { TranslationPanel } from "./components/TranslationPanel"
import { parseAppStoreUrl } from "./utils/itunes"

function readShortcutValue() {
  const parameter = Intent.shortcutParameter as any
  if (!parameter) return ""

  if (typeof parameter === "string") return parameter
  if (typeof parameter?.value === "string") return parameter.value
  if (typeof parameter?.url === "string") return parameter.url
  if (typeof parameter?.absoluteString === "string") return parameter.absoluteString
  return ""
}

function firstString(values: unknown) {
  if (!Array.isArray(values)) return ""
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof (value as any)?.absoluteString === "string" && (value as any).absoluteString.trim()) {
      return (value as any).absoluteString.trim()
    }
    if (typeof (value as any)?.url === "string" && (value as any).url.trim()) {
      return (value as any).url.trim()
    }
  }
  return ""
}

function collectInput() {
  return (
    firstString(Intent.urlsParameter) ||
    firstString(Intent.textsParameter) ||
    readShortcutValue()
  )
}

function EmptyInputView() {
  return (
    <NavigationStack>
      <List
        navigationTitle="翻译器"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
      >
        <Section>
          <Text foregroundStyle="secondaryLabel">
            没有收到可翻译的文本或 App Store 链接。
          </Text>
        </Section>
      </List>
    </NavigationStack>
  )
}

async function run() {
  const input = collectInput()
  const parsed = parseAppStoreUrl(input)

  await Navigation.present({
    element: parsed ? (
      <NavigationStack>
        <AppStoreTranslateView
          parsed={parsed}
          originalInput={input}
        />
      </NavigationStack>
    ) : input.trim() ? (
      <NavigationStack>
        <TranslationPanel
          inputText={input}
          allowsReplacement={false}
        />
      </NavigationStack>
    ) : (
      <EmptyInputView />
    ),
  })

  Script.exit()
}

void run()
