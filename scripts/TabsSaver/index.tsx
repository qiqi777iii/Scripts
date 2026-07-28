import { Navigation, NavigationStack, Script } from "scripting"
import TabsManagerView from "./TabsManagerView"

function StandaloneTabsManager() {
  const dismiss = Navigation.useDismiss()
  return (
    <NavigationStack>
      <TabsManagerView onClose={dismiss} />
    </NavigationStack>
  )
}

async function run() {
  await Navigation.present(<StandaloneTabsManager />)
  Script.exit()
}

run()
