import { HStack, Image, Link, Script, Spacer, Text, VStack, Widget } from "scripting"
import { getFavorites, loadStore, totalBookmarkCount, type Store } from "./store"

function WidgetView({ store }: { store: Store }) {
  const total = totalBookmarkCount(store)
  const favorites = getFavorites(store).length
  const groups = store.groups.length
  const compact = Widget.family === "systemSmall"

  return (
    <Link url={Script.createRunSingleURLScheme("Tabs Saver")}>
      <VStack
        padding={compact ? 14 : 16}
        alignment="center"
        spacing={compact ? 7 : 9}
      >
        <HStack spacing={8}>
          <Image
            systemName="bookmark.fill"
            foregroundStyle="systemBlue"
            font={compact ? 22 : 24}
          />
          <Text font="headline" fontWeight="bold" lineLimit={1}>
            标签页收藏
          </Text>
        </HStack>

        <Spacer />

        <Text
          font={compact ? 52 : 58}
          fontWeight="bold"
          fontDesign="rounded"
          foregroundStyle="systemBlue"
          lineLimit={1}
          minScaleFactor={0.7}
        >
          {String(total)}
        </Text>
        <Text
          font={compact ? "headline" : "title3"}
          fontWeight="semibold"
          foregroundStyle="secondaryLabel"
        >
          已收藏网页
        </Text>

        {!compact && (
          <HStack spacing={18}>
            <Text font="caption" foregroundStyle="secondaryLabel">
              {`${groups} 个分组`}
            </Text>
            <Text font="caption" foregroundStyle="secondaryLabel">
              {`${favorites} 个星标`}
            </Text>
          </HStack>
        )}

        <Spacer />
      </VStack>
    </Link>
  )
}

async function runWidget() {
  const store = await loadStore()
  Widget.present(<WidgetView store={store} />, { policy: "never" })
}

runWidget()
