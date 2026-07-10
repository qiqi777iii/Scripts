import { fetch } from "scripting"

export type ParsedAppStoreUrl = {
  appId: string
  region: string
}

export type AppStoreInfo = {
  trackId: number
  trackName: string
  artistName: string
  sellerName: string
  bundleId: string
  version: string
  currentVersionReleaseDate: string
  releaseNotes: string
  description: string
  artworkUrl100: string
  trackViewUrl: string
  minimumOsVersion: string
  fileSizeBytes: string
  formattedPrice: string
  averageUserRating?: number
  userRatingCount?: number
}

const DEFAULT_REGION = "cn"

function normalizeRegion(value: string | undefined | null) {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (/^[a-z]{2}$/.test(normalized)) return normalized
  return DEFAULT_REGION
}

function normalizeCandidate(raw: string) {
  return String(raw ?? "").trim().replace(/[\s\u3000]+$/g, "")
}

function parseFromUrlLike(value: string): ParsedAppStoreUrl | null {
  const candidate = normalizeCandidate(value)
  if (!candidate) return null

  const appStoreUrlMatch = candidate.match(/https?:\/\/apps\.apple\.com\/([a-z]{2})\/app\/[^\s?#]+\/id(\d+)/i)
  if (appStoreUrlMatch) {
    return {
      region: normalizeRegion(appStoreUrlMatch[1]),
      appId: appStoreUrlMatch[2],
    }
  }

  const appStorePathMatch = candidate.match(/apps\.apple\.com\/([a-z]{2})\/app\/[^\s?#]+\/id(\d+)/i)
  if (appStorePathMatch) {
    return {
      region: normalizeRegion(appStorePathMatch[1]),
      appId: appStorePathMatch[2],
    }
  }

  const appStoreQueryMatch = candidate.match(/apps\.apple\.com\/([a-z]{2})\/app\/[^\s?#]+[^\s]*[?&]id=(\d+)/i)
  if (appStoreQueryMatch) {
    return {
      region: normalizeRegion(appStoreQueryMatch[1]),
      appId: appStoreQueryMatch[2],
    }
  }

  const exactIdMatch = candidate.match(/^id?(\d{6,})$/i)
  if (exactIdMatch) {
    return {
      region: DEFAULT_REGION,
      appId: exactIdMatch[1],
    }
  }

  return null
}

export function parseAppStoreUrl(raw: string): ParsedAppStoreUrl | null {
  const text = String(raw ?? "").trim()
  if (!text) return null

  const direct = parseFromUrlLike(text)
  if (direct) return direct

  const urlMatches = text.match(/https?:\/\/apps\.apple\.com\/[^\s]+/gi) ?? []
  for (const item of urlMatches) {
    const parsed = parseFromUrlLike(item)
    if (parsed) return parsed
  }

  const looseMatches = text.match(/apps\.apple\.com\/[^\s]+/gi) ?? []
  for (const item of looseMatches) {
    const parsed = parseFromUrlLike(item)
    if (parsed) return parsed
  }

  return null
}

function normalizeInfo(raw: any): AppStoreInfo {
  return {
    trackId: Number(raw?.trackId ?? 0),
    trackName: String(raw?.trackName ?? ""),
    artistName: String(raw?.artistName ?? ""),
    sellerName: String(raw?.sellerName ?? ""),
    bundleId: String(raw?.bundleId ?? ""),
    version: String(raw?.version ?? ""),
    currentVersionReleaseDate: String(raw?.currentVersionReleaseDate ?? ""),
    releaseNotes: String(raw?.releaseNotes ?? ""),
    description: String(raw?.description ?? ""),
    artworkUrl100: String(raw?.artworkUrl100 ?? ""),
    trackViewUrl: String(raw?.trackViewUrl ?? ""),
    minimumOsVersion: String(raw?.minimumOsVersion ?? ""),
    fileSizeBytes: String(raw?.fileSizeBytes ?? ""),
    formattedPrice: String(raw?.formattedPrice ?? ""),
    averageUserRating: typeof raw?.averageUserRating === "number" ? raw.averageUserRating : undefined,
    userRatingCount: typeof raw?.userRatingCount === "number" ? raw.userRatingCount : undefined,
  }
}

export async function getAppInfo(appId: string, region = DEFAULT_REGION): Promise<AppStoreInfo> {
  const normalizedId = String(appId ?? "").trim()
  if (!/^\d+$/.test(normalizedId)) {
    throw new Error("无法识别 App ID。")
  }

  const storeRegion = normalizeRegion(region)
  const response = await fetch(`https://itunes.apple.com/${storeRegion}/lookup?id=${encodeURIComponent(normalizedId)}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new Error(`App Store 查询失败（HTTP ${response.status}）。`)
  }

  const payload = await response.json()
  const item = Array.isArray(payload?.results) ? payload.results[0] : null
  if (!item) {
    throw new Error("没有找到这个 App，请检查链接或地区。")
  }

  return normalizeInfo(item)
}
