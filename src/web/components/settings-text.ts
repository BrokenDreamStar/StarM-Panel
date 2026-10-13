/**
 * 设置面板的全部说明文案 —— 想改设置里的文字，只动这一个文件。
 *
 * 结构：
 *   - SETTINGS_SECTIONS：左侧分类（label = 分类名，desc = 面板标题下的副标题）
 *   - SETTINGS_HINTS：每个设置项标签下的说明，键名对应设置项
 *   - glassStyleHint / glassTransparencyHint：跟着 UI 风格变化的说明
 */

export type SectionKey = 'appearance' | 'home' | 'network' | 'monitor' | 'about'

export interface SettingsSection {
  key: SectionKey
  /** 左侧导航项与面板标题 */
  label: string
  /** 图标名（见 components/FaviconGlyph.vue） */
  icon: string
  /** 面板标题下的副标题 */
  desc: string
}

/** 左侧分类 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { key: 'appearance', label: '外观', icon: 'image', desc: '主题模式、主色、玻璃材质与壁纸' },
  { key: 'home', label: '首页', icon: 'home', desc: '标题、时钟、卡片尺寸与状态分区' },
  { key: 'network', label: '网络', icon: 'wifi', desc: '内外网访问判定与模式切换' },
  { key: 'monitor', label: '监控', icon: 'cpu', desc: '采样周期与后台省电周期' },
  { key: 'about', label: '关于', icon: 'server', desc: '版本与运行环境' },
]

/** 设置项标签下的说明文字（键名即设置项，方便对照） */
export const SETTINGS_HINTS = {
  // 外观
  themeMode: '只切换明暗，不动材质和透明度。',
  blur: '壁纸的高斯模糊半径，0 就是清晰。',
  wallpaperType: '渐变和纯色都在本地渲染，离线也能用。',
  wallpaperUpload: '上传后自动切到自定义图片。',
  wallpaperText: '标题、时钟这些文字的颜色，深色壁纸配白字，浅色壁纸配黑字。',
  resetAppearance: '把外观恢复成出厂设置，不影响首页、网络和监控。',
  // 首页
  homeTitle: '失焦或回车后保存。',
  showClock: '标题右边显示时间和日期。',
  cardSize: '应用卡片和硬件卡片一起变大小。',
  openMode: '卡片的默认打开方式，右键可以单次覆盖。',
  showMonitor: '关闭后首页不显示硬件卡片，后台照常采集。',
  // 网络
  autoMode: '按访问方式判断：IP 和 localhost 算内网，域名算外网。',
  networkMode: '关掉「自动选择」后才生效。',
  // 监控
  monitorInterval: '单位毫秒，失焦或回车后保存。',
  hiddenInterval: '页面切到后台时的采样间隔，用来省电。',
} as const

export type GlassStyle = 'solid' | 'frost' | 'liquid'

/** UI 风格说明，随所选风格变化 */
export function glassStyleHint(style: GlassStyle): string {
  if (style === 'solid') return '纯色底，没有模糊，最省性能。'
  if (style === 'liquid') return '带边缘高光的液态玻璃，开销最高。'
  return '半透明底加高斯模糊。'
}

/** 卡片透明度说明：0 不透明、100 全透明，各风格的默认值不同 */
export function glassTransparencyHint(style: GlassStyle): string {
  if (style === 'liquid') return '0 不透明，100 全透明；深色主题下这个滑杆不生效。'
  if (style === 'solid') return '0 不透明，100 全透明，默认 10%。'
  return '0 不透明，100 全透明，默认 20%。'
}
