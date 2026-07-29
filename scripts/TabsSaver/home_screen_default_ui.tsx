import { NavigationStack } from "scripting"
import TabsManagerView from "./TabsManagerView"

export default function HomeScreenDefaultUI() {
  return (
    <NavigationStack>
      <TabsManagerView homeScreen />
    </NavigationStack>
  )
}
