/**
 * 全站界面文案总表 —— **前端给用户看的字全在这里，改文案只动这一个文件。**
 *
 * 约定（改之前先读这三条）：
 *
 *   1. 只收「前端界面文案」：标签、按钮、占位符、弹窗、toast、tooltip。
 *      后端返回的报错原文（如 HttpError 的 message）不在表内 —— 那是服务端的口径，
 *      前端只负责透传，抄一份进来会立刻产生两个真相。
 *      纯代码常量（路由 path、设置项 key、CSS 类名、`—` 这类占位符号）同样不收；
 *      计量单位符号（`GB` / `GHz` / `°C` / `Mbit/s` / `px` / `ms`）也不收 ——
 *      它们跟着数值排版，属于格式化而不是文案（见 utils/format.ts）。
 *
 *   2. 带参数的句子一律写成函数，**调用处不再自己拼中文**：
 *      `T.settings.saved('主题模式')` 而不是 `` `${label} 已保存` ``。
 *      这样语序、量词、空格只有一处可改。
 *
 *   3. 原文里被换行/标签切开的句子，先合成一条完整文案，组件侧用计算属性取出，
 *      不要把一句话拆成前后两个键（拆了就再也无法整体调整语序）。
 *
 * 用到的组件这样引入：
 *
 *   import { TEXT as T } from '@shared/text'
 *
 * 另外文件末尾保留设置面板的「结构 + 文案」复合导出（SETTINGS_* 等已并入
 * `TEXT.settings`，类型 `SectionKey` / `GlassStyle` / `SettingsSection` 仍单独导出）。
 */

/** 设置弹窗左侧分类的键 */
export type SectionKey = 'appearance' | 'home' | 'misc' | 'security' | 'data' | 'about'

/** UI 风格标识（取值与设置项 `ui.glassStyle` 一致） */
export type GlassStyle = 'solid' | 'frost' | 'liquid'

/** 设置分类：label / desc 是文案，icon 是导航图标名（见 components/FaviconGlyph.vue） */
export interface SettingsSection {
	key: SectionKey
	/** 左侧导航项与面板标题 */
	label: string
	/** 图标名 */
	icon: string
	/** 面板标题下的副标题，留空则不渲染 */
	desc: string
}

export const TEXT = {
	/**
	 * 通用词：跨组件复用的短词（取消 / 删除 / 内网 …）。
	 * 只放**语义完全一致**的词；同一个词在不同语境下有细微差别时各留一份，
	 * 免得改一处连带改掉别处。
	 */
	common: {
		/** Naive 弹窗 / 气泡的取消按钮 */
		cancel: '取消',
		delete: '删除',
		/** 后端没给错误消息时的兜底 */
		unknown: '未知',
		unknownError: '未知错误',
		deleteFailed: '删除失败',
		/** 各处文件选择框选到了非图片文件 */
		chooseImageFile: '请选择图片文件',
		/** 分组缺失时的兜底名，卡片编辑器的分组下拉也用它 */
		ungrouped: '未分组',
		lan: '内网',
		wan: '外网',
		light: '浅色',
		dark: '深色',
		system: '跟随系统',
		/** zod 密码校验失败时的兜底提示（登录页与「设置 → 安全」共用） */
		passwordInvalid: '密码不符合要求',
		passwordMismatch: '两次输入的密码不一致',
	},

	/** 请求层（api/client.ts） */
	api: {
		/** 后端响应里没有可用错误消息时的兜底 */
		requestFailed: (status: number) => `请求失败（HTTP ${status}）`,
	},

	/** 路由标题（router/index.ts） */
	router: {
		/** 产品名：单独留着，标题后缀与兜底标题共用 */
		brand: 'StarM Panel',
		pageTitle: (title: string) => `${title} · StarM Panel`,
		homeTitle: '桌面',
		setupTitle: '初始化 · StarM Panel',
		loginTitle: '登录 · StarM Panel',
	},

	/** 后端不可达时的兜底提示（components/BootNotice.vue） */
	boot: {
		title: '无法加载面板数据',
		/** 默认后端地址，插在下面两句中间以等宽字体展示 */
		defaultBackendUrl: 'http://127.0.0.1:3002',
		hintBefore: '请确认后端已启动（默认 ',
		hintAfter: '），然后重试。当前页面在离线状态下仍会保留本地缓存的网络模式与主题。',
		retry: '重试',
	},

	/** 登录页（views/LoginView.vue）；「设置 → 安全」的改密表单复用其中几条 */
	login: {
		passwordLabel: '密码',
		newPasswordLabel: '新密码',
		passwordPlaceholder: '管理员密码',
		passwordSetupPlaceholder: '至少 8 位',
		confirmLabel: '确认密码',
		confirmPlaceholder: '再输入一次',
		submitLogin: '登录',
		submitSetup: '设置并进入',
		/** 锁定倒计时：先按秒，满一分钟改按分钟 */
		waitSeconds: (seconds: number) => `${seconds} 秒`,
		waitMinutes: (minutes: number) => `${minutes} 分钟`,
		tooManyAttempts: (wait: string) => `尝试次数过多，请 ${wait} 后再试`,
		waiting: (seconds: number) => `请稍候 ${seconds}s`,
		passwordRequired: '请输入密码',
	},

	/** 首页（views/HomeView.vue） */
	home: {
		networkModeSwitched: (mode: string) => `网络模式：${mode}`,
		/** 应用卡片区的分区标题 */
		appsSection: 'APP',
		/** 页脚两行 */
		footerPowered: 'Powered By StarM Panel',
		footerCopyright: 'Copyright ©2021-2026 StarM Team',
	},

	/** 右下角浮动控件（components/FloatingControls.vue） */
	controls: {
		openSettings: '打开设置',
		/** 自动模式：说明当前按哪种方式解析 */
		modeAuto: (resolved: string) => `网络模式：自动（当前按${resolved}解析，点击改为手动切换）`,
		modeLanManual: '网络模式：内网（点击切换到外网）',
		modeWanManual: '网络模式：外网（点击切换到内网）',
		modeLanSwitch: '网络模式：内网，点击切换到外网',
		modeWanSwitch: '网络模式：外网，点击切换到内网',
	},

	/** 主题开关（components/ThemeSwitch.vue） */
	themeSwitch: {
		toggleAria: '切换浅色 / 深色主题',
		current: (theme: string) => `当前主题：${theme}（点击切换浅色 / 深色）`,
	},

	/** 首页英雄区（components/HeroHeader.vue） */
	header: {
		/** 索引即 Date.getDay()：0 = 周日 */
		weekdays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
	},

	/** APP 分组（components/GroupSection.vue） */
	group: {
		rename: '重命名',
		createItem: '在此分组新建卡片',
		delete: '删除分组（卡片保留）',
		/** 分组标题的折叠开关 */
		cannotCollapse: '未分组卡片不可折叠',
		expand: '展开',
		collapse: '折叠',
		newItem: '新建卡片',
		menuAria: '分组操作',
		deleteConfirm: (name: string, count: number) =>
			`删除分组「${name}」？组内 ${count} 张卡片会变为未分组，不会被删除。`,
	},

	/** 应用卡片（components/ItemCard.vue） */
	item: {
		openSelf: '当前窗口打开',
		openNewTab: '新窗口打开',
		edit: '编辑',
		copyLink: '复制链接',
		openInNewWindow: '在新窗口打开',
		ariaEdit: (title: string) => `${title}（点击编辑）`,
		ariaOpen: (title: string, openMode: string) => `${title}（${openMode}）`,
		/** 网络来源角标：实际用了哪套地址 */
		sourceTooltip: (source: string) => `实际使用「${source}」地址`,
		/** 角标只在「与全局模式不一致」时常显，这是它的说明 */
		badgeTooltip: '与当前全局模式不一致时才显示此角标',
		pinnedTooltip: (mode: string) => `该卡片固定使用${mode}地址，不随全局模式切换`,
		removeAria: (title: string) => `移除「${title}」`,
	},

	/** 分区标题上隐藏的「编辑」开关（components/SectionEditToggle.vue） */
	sectionToggle: {
		show: '编辑卡片',
		done: '完成编辑',
	},

	/** 卡片编辑器（components/CardEditor.vue） */
	card: {
		/** 弹窗标题 */
		titleEdit: '编辑卡片',
		titleNew: '新建卡片',
		/** 表单标签 */
		form: {
			title: '标题',
			subtitle: '副标题',
			lanUrl: '内网地址',
			wanUrl: '外网地址',
			networkPref: '网络偏好',
			group: '所属分组',
			icon: '图标',
		},
		formTitlePlaceholder: '例如：StarM Panel',
		formSubtitlePlaceholder: '可选，例如：StarM面板',
		formLanUrlPlaceholder: '192.168.1.1:8080',
		formWanUrlPlaceholder: 'https://nas.example.com',
		groupNamePlaceholder: '分组名称，例如：家庭服务',
		iconNamePlaceholder: '或直接输入图标名，如 mdi:server',
		iconSearchPlaceholder: '搜索图标名，如 server / video / home',
		iconSourceAria: '图标来源',
		iconPreviewAlt: '图标预览',
		iconNotSet: '未设置',
		/** 图标来源一级菜单 */
		iconSource: {
			asset: '上传',
			text: '文字',
			favicon: '抓取',
			iconify: '图标库',
		},
		/** 图标库里的分组名（顺序即展示顺序） */
		iconGroups: {
			common: '通用',
			actions: '操作与状态',
			accounts: '账户与通讯',
			system: '系统与品牌',
			ops: '运维与服务',
			storage: '存储与数据库',
			network: '网络',
			media: '媒体与设备',
			hardware: '硬件与图表',
			life: '生活与出行',
		},
		/** 图标来源按钮的提示（未选过 / 选过之后文案不同） */
		uploadHint: {
			fresh: '选择图片上传',
			again: '重新选择图片',
			title: '支持 PNG / JPEG / GIF / WebP / SVG / ICO，单个 ≤256KB',
		},
		faviconHint: {
			fresh: '抓取 favicon',
			again: '重新抓取 favicon',
		},
		iconifyHint: {
			fresh: '打开图标库',
			again: '重新选择图标',
			title: '打开图标库挑选图标',
		},
		/** favicon 抓取来源的两个 chip */
		faviconSourceTitle: (label: string, url: string) =>
			`从${label}地址抓取 favicon：${url}（右侧可切换内网 / 外网）`,
		faviconSourceEmpty: '用卡片的内网 / 外网地址抓取 favicon —— 先在表单里填一个地址',
		svgPreviewLan: (url: string) => `用内网地址抓取：${url}`,
		svgPreviewWan: (url: string) => `用外网地址抓取：${url}`,
		addressMissingLan: '未填写内网地址',
		addressMissingWan: '未填写外网地址',
		/** 「文字」来源的两个取色器 */
		colorText: '文字',
		colorBackground: '背景',
		iconColorTextTitle: '图标文字颜色',
		iconColorBackgroundTitle: '图标背景色',
		clear: '清除',
		save: '保存',
		create: '创建',
		done: '完成',
		/** 图标库空结果提示（原文分两行，这里合成一条） */
		iconSearchEmpty:
			'没有匹配的内置图标，可在下方直接输入任意图标名 —— 未内置的形状会用几何字形兜底。',
		/** 新建分组弹窗 */
		newGroupTitle: '新建分组',
		newGroupFailed: '新建分组失败',
		/** 关闭前的未保存确认 */
		unsavedTitle: '未保存的修改',
		unsavedContent: '关闭后将丢失未保存的修改。',
		discardAndClose: '放弃修改并关闭',
		continueEditing: '继续编辑',
		/** 网络偏好选项 */
		networkAuto: '继承全局',
		networkLan: '强制内网',
		networkWan: '强制外网',
		/** 校验与结果提示 */
		needAddress: '请先填写内网地址或外网地址',
		faviconMissingLan: '未填写内网地址，换外网试试',
		faviconMissingWan: '未填写外网地址，换内网试试',
		faviconFetched: (label: string) => `已从${label}地址抓取 favicon`,
		faviconFailed: (label: string, message: string) => `${label}地址抓取失败：${message}`,
		titleRequired: '标题不能为空',
		addressRequired: '内网地址与外网地址至少填写一个',
		updated: '卡片已更新',
		created: '卡片已创建',
		saveFailed: '保存失败',
		deleted: '卡片已删除',
		readFileFailed: '读取文件失败',
		iconTooLarge: (kb: string) => `图标不能超过 256KB（当前 ${kb}KB）—— 建议改用矢量图标`,
		iconUploaded: '图标已上传',
		inlineTooLarge: '图片太大，内联存储会超出图标字段长度上限（4096 字符）',
		uploadUnavailable: (message: string) => `上传接口不可用（${message}），已改为内联存储`,
		uploadFallback: '上传失败，已改为内联存储',
		iconReadFailed: '图标读取失败',
		/** 二级删除确认（标题由 useDeleteConfirm 提供） */
		confirmDelete: (title: string) => `确定删除「${title}」？`,
	},

	/** 首页硬件分区（components/SystemStatusSection.vue） */
	status: {
		title: '系统状态',
		/** 「添加卡片」位与浮层 */
		addButton: '添加卡片',
		allAdded: '已添加全部信息卡片',
		empty: '还没有信息卡片 —— 点「添加卡片」选择要展示的系统信息。',
		removeCard: '移除卡片',
		removeCardAria: (name: string) => `移除「${name}」卡片`,
		removeCardConfirm: (name: string) =>
			`确定移除「${name}」卡片？之后可在「添加卡片」中重新加回。`,
		remove: '移除',
	},

	/** 首页硬件卡片（components/SystemStatCard.vue） */
	statCard: {
		viewDetail: (title: string) => `查看${title}详情`,
		staticInfo: '静态信息',
	},

	/** 硬件详情弹窗（components/SystemStatDetail.vue） */
	detail: {
		loading: '正在读取系统数据…',
		waiting: '等待采样…',
		/** 弹窗标题：磁盘用挂载点，其余用卡片名 + 「详情」 */
		diskTitle: (device: string) => `磁盘 ${device}`,
		detailTitle: (title: string) => `${title}详情`,
		/** CPU 块 */
		cpuTotal: '总使用率',
		loadPrefix: '负载 1/5/15：',
		live: '实时',
		cores: (count: number) => `${count} 核心`,
		perCore: '每核心使用率',
		recentSamples: (count: number) => `最近 ${count} 次采样`,
		/** 内存块 */
		usedOfTotal: '已用 / 总量',
		/** 交换分区小标题与「静态信息」表里的行名（缩写沿用系统口径） */
		swap: 'SWAP',
		used: '已用',
		cached: '缓存',
		free: '空闲',
		available: '可用',
		usedSharedWithMemory: (bytes: string) => `${bytes}（已用，与内存共享）`,
		/** 磁盘块 */
		capacityDevices: '容量与设备',
		/** 网卡块 */
		noNetifaces: '没有可显示的网卡。',
		noIp: '无 IP',
		down: '下行',
		up: '上行',
		bytesReceived: '累计接收',
		bytesSent: '累计发送',
		linkSpeed: '链路速率',
		/** 网卡物理地址行名 */
		mac: 'MAC',
		netifaceCount: (count: number) => `${count} 个网卡`,
		/** GPU 块 */
		noGpu: '未检测到 GPU 设备。',
		gpuNoMetrics: '该平台不暴露 GPU 动态指标',
		gpuNote:
			'Windows / Linux + 独显环境下会显示使用率、温度、功耗等指标；macOS 的 Apple Silicon 不提供这些数据。',
		model: '型号',
		manufacturer: '厂商',
		vram: '显存',
		driver: '驱动',
		bus: '总线',
		sharedWithMemory: (bytes: string) => `${bytes}（与内存共享）`,
		gpuCount: (count: number) => `${count} 个 GPU 设备`,
		/** GPU 指标名（键与 SystemSnapshot 的指标键对齐） */
		gpuMetric: {
			utilization: '使用率',
			memory: '显存',
			temperature: '温度',
			power: '功耗',
			fan: '风扇转速',
			clock: '频率',
		},
		/** 主机块 */
		runtime: '运行时长',
		hostInfo: '主机信息',
		sampleTime: '实时采样时间',
		processor: '处理器',
		memorySwap: '物理内存与交换分区',
		diskUsage: '磁盘使用情况',
		/** 键值表行名（「静态信息」表） */
		kv: {
			model: '型号',
			manufacturer: '厂商',
			coresThreads: '核心/线程',
			coresThreadsValue: (physical: number, logical: number) =>
				`${physical} 核心 / ${logical} 线程`,
			speed: '主频',
			totalMemory: '总内存',
			free: '空闲',
			available: '可用',
			mount: '挂载点',
			fileSystem: '文件系统',
			device: '设备',
			totalCapacity: '总容量',
			used: '已用',
			readRate: '读取速率',
			writeRate: '写入速率',
			hostname: '主机名',
			distro: '发行版',
			kernel: '内核',
			arch: '架构',
			uptime: '运行时长',
			processes: '进程数',
			users: '用户数',
			cpuModel: 'CPU 型号',
			memoryTotal: '内存总量',
		},
	},

	/** 可添加的硬件卡片目录（composables/useStatCards.ts） */
	statCards: {
		cpuName: 'CPU 使用率',
		cpuHint: '总使用率与每核心明细',
		memoryTitle: '内存',
		memoryName: '内存',
		memoryHint: '已用 / 总量与交换分区',
		diskTitle: '磁盘',
		diskName: '磁盘',
		diskHint: '已用 / 总量与读写速率',
		networkTitle: '网络',
		networkName: '网络',
		networkHint: '该网卡的上下行速率',
		gpuHint: '使用率与显存',
		systemTitle: '系统',
		systemName: '系统信息',
		systemHint: '运行时长、主机与内核版本',
		diskDevice: (device: string) => `磁盘 ${device}`,
		netifaceDevice: (device: string) => `网卡 ${device}`,
		mountHint: '该挂载点的容量与读写速率',
		ifaceHint: '该网卡的上行 / 下行速率',
	},

	/** 删除确认弹窗（composables/useDeleteConfirm.ts） */
	confirm: {
		deleteTitle: '删除卡片',
		deleteContent: (title: string) => `删除后无法恢复，确定删除「${title}」？`,
	},

	/** 卡片右键菜单与复制（composables/useItemActions.ts） */
	actions: {
		noAddress: (title: string) => `「${title}」没有可用的地址`,
		nothingToCopy: '没有可复制的地址',
		copied: '链接已复制',
		copyFailed: '复制失败，请手动复制',
		deleted: (title: string) => `已删除「${title}」`,
	},

	/** 监控 SSE（composables/useMonitorStream.ts） */
	monitor: {
		disconnected: '监控连接已断开，正在重连…',
	},

	/** 网络模式持久化失败的兜底消息（stores/network.ts） */
	network: {
		persistFailed: '写入失败',
	},

	/**
	 * 时长/数量单位（utils/format.ts、各处的倒计时）。
	 * 数值与单位之间的空格由这里统一决定，调用处不要再拼。
	 */
	duration: {
		daysHours: (days: number, hours: number) => `${days} 天 ${hours} 小时`,
		hoursMinutes: (hours: number, minutes: number) => `${hours} 小时 ${minutes} 分`,
		minutes: (minutes: number) => `${minutes} 分`,
		days: (days: number) => `${days} 天`,
		hours: (hours: number) => `${hours} 小时`,
		seconds: (seconds: number) => `${seconds} 秒`,
	},

	/** 设置弹窗（components/SettingsModal.vue） */
	settings: {
		/** 外壳 */
		title: '设置',
		ariaLabel: '设置',
		navAriaLabel: '设置分类',
		backToDesktop: '返回桌面',
		close: '关闭',

		/** 左侧分类：数组顺序即导航顺序 */
		sections: [
			{ key: 'appearance', label: '外观', icon: 'image', desc: '' }, // 主题与壁纸设置
			{ key: 'home', label: '首页', icon: 'home', desc: '' }, // 首页显示内容
			{ key: 'security', label: '安全', icon: 'lock', desc: '' }, // 管理员登录、密码与会话
			{ key: 'data', label: '数据', icon: 'database', desc: '' }, // 备份导出 / 导入（换机迁移）
			{ key: 'misc', label: '其它', icon: 'cog', desc: '' }, // 网络、监控与卡片打开方式
			{ key: 'about', label: '关于', icon: 'server', desc: '' }, // 版本与运行环境
		] as SettingsSection[],

		/**
		 * 设置项的标签（左列）。
		 *
		 * 与 hints 用同一套键名，但**默认是有文字的中文** —— 标签是界面必需的信息，
		 * 不像说明那样可以留空（留空会只剩一排控件看不懂）。
		 * toast 里的「XX 已保存」也复用这里的标签，改一处两处都跟着变。
		 */
		labels: {
			// 外观
			themeMode: '主题模式',
			accent: '主题色',
			glassStyle: 'UI 风格',
			transparency: '卡片透明度',
			blur: '模糊度',
			cardSize: '卡片尺寸',
			wallpaperType: '壁纸类型',
			wallpaperColor: '壁纸颜色',
			wallpaperUrl: '图片地址',
			wallpaperUpload: '上传图片',
			wallpaperText: '文字颜色',
			resetAppearance: '还原默认配置',
			// 首页
			homeTitle: '首页标题',
			showClock: '首页显示时钟',
			showMonitor: '首页「系统状态」分区',
			// 其它（网络 / 监控 / 卡片行为）
			openMode: '卡片打开方式',
			networkMode: '默认网络模式',
			autoMode: '自动选择网络模式',
			monitorInterval: '采样间隔',
			hiddenInterval: '后台采样间隔',
			// 安全
			sessions: '当前会话',
			loginProtection: '登录保护',
			currentPassword: '当前密码',
			newPassword: '新密码',
			confirmPassword: '确认新密码',
			changePassword: '修改密码',
			logout: '退出登录',
			revokeAll: '退出所有设备',
			// 数据（备份 / 迁移）
			exportData: '导出备份',
			importData: '导入备份',
		},

		/** 设置项标签下的说明文字，留空则不渲染 */
		hints: {
			// 外观
			themeMode: '',
			accent: '',
			blur: '',
			cardSize: '',
			wallpaperType: '',
			wallpaperColor: '',
			wallpaperUrl: '填写图片文件路径或图片URL',
			wallpaperUpload: '',
			wallpaperText: '设置首页标题、时钟与分组名称的文字颜色，以适配不同明暗度的壁纸',
			resetAppearance: '将主题、UI风格、卡片尺寸与壁纸恢复为默认配置',
			// 首页
			homeTitle: '',
			showClock: '',
			showMonitor: '',
			// 其它
			openMode: '',
			networkMode: '',
			autoMode: '开启后通过IP访问则默认为内网 通过域名访问默认为外网',
			monitorInterval: '设置面板处于前台时的硬件状态采样周期',
			hiddenInterval: '设置页面切入后台时的硬件状态采样周期',
			// 安全
			loginProtection: '开启后访问面板需验证管理员密码，仅建议在完全可信的局域网环境中关闭',
			sessions: '',
			changePassword: '',
			passwordReset: '如忘记密码，可通过 --reset-auth 启动参数重置认证信息',
			logout: '',
			revokeAll: '',
			// 数据（备份 / 迁移）
			exportData: '',
			importData: '',
		},

		/**
		 * 键值行（label: value）的行名 —— 「安全」面板的会话信息与「关于」面板的规格表。
		 * 值那一侧是动态数据，不在这里。
		 */
		kv: {
			// 安全：当前会话
			loginState: '登录状态',
			lastLogin: '上次登录',
			lastLoginIp: '来源 IP',
			sessionTtl: '会话有效期',
			// 关于：运行环境
			version: '版本',
			uptime: '运行时长',
			platform: '平台',
			hostname: '主机名',
			cpu: 'CPU',
			kernel: '内核',
		},

		/** 单选项的文案（选项的 value 仍写在组件里，这里只有 label） */
		options: {
			wallpaperType: {
				solid: '纯色',
				gradient: '渐变',
				asset: '自定义图片',
				bing: '必应每日壁纸',
			},
			cardSize: {
				sm: '紧凑',
				md: '标准',
				lg: '宽松',
			},
			wallpaperText: {
				auto: '跟随主题（默认）',
				light: '白色',
				dark: '黑色',
			},
			openMode: {
				newTab: '新窗口',
				self: '当前窗口',
			},
			glassStyle: {
				solid: '扁平化（默认）',
				frost: '毛玻璃',
				liquid: '液态玻璃',
			},
		},

		/**
		 * 导出弹窗的文案。
		 *
		 * 与 importDialog 对称：导出内容（含资源 / 仅配置）是这条流程的参数，
		 * 不占设置页的一行常驻配置。
		 */
		exportDialog: {
			/** 唯一的选项组标题 */
			stepContent: '选择导出内容',
			withAssets: '包含图标与壁纸（推荐）',
			withAssetsDesc: '',
			configOnly: '仅配置',
			configOnlyDesc: '',
			/** 底部按钮 */
			confirm: '导出',
		},

		/**
		 * 导入弹窗的分步文案。
		 *
		 * 导入不是「改一个设置」而是两步流程（先选文件 → 再选合并 / 覆盖），
		 * 所以文案单独放一份，不塞进 labels / hints 的标签-说明结构。
		 */
		importDialog: {
			/** 第一步：选文件 */
			stepFile: '选择备份文件',
			fileHint: '本面板导出的 JSON 备份文件',
			fileChosen: '已选择，点击可重新选择',
			/** 第二步：选导入方式（选完文件才出现） */
			stepMode: '这份备份怎么处理现有数据？',
			merge: '合并',
			mergeDesc: '保留现有数据，将备份里的分组与卡片追加进来',
			replace: '覆盖',
			replaceDesc: '清空现有分组与卡片，写入备份内容',
			/** 底部按钮：按所选方式换文案 */
			confirm: '开始导入',
			confirmReplace: '覆盖并导入',
		},

		// ── 外观 ──
		/** 滑杆数值：平时是只读文本（按钮外观），点击后换成 number 框 */
		sliderInputTitle: '点击输入具体数值',
		resetToDefaultPct: (percent: number) => `恢复默认（${percent}%）`,
		transparencyResetAria: (percent: number) => `卡片透明度恢复默认（${percent}%）`,
		resetToDefaultPx: (pixels: number) => `恢复默认（${pixels}px）`,
		blurResetAria: (pixels: number) => `模糊度恢复默认（${pixels}px）`,
		wallpaperUrlPlaceholder: '~/bg/bg.png 或 https://…/bg.png',
		uploading: '上传中…',
		chooseImage: '选择图片',
		resetAppearanceButton: '还原默认',
		resetAppearanceConfirm: '外观的所有选项都将恢复为默认值，确定继续？',
		appearanceReset: '外观已恢复默认配置',
		resetFailed: '恢复默认失败（已保留本地改动）',
		wallpaperUploadFailed: (message: string) => `壁纸上传失败：${message}`,
		/** 透明度文本态的极值 */
		opaque: '不透明',
		transparent: '透明',
		/** toast 里用来指代本次改动的名字（与 labels 不完全同名，故单列） */
		labelWallpaper: '壁纸',
		labelWallpaperText: '壁纸文字颜色',
		labelShowClock: '首页时钟',
		labelShowMonitor: '系统状态分区',

		// ── 首页 ──
		homeTitlePlaceholder: '留空显示 StarM Panel',

		// ── 安全 ──
		loggedIn: '已登录',
		loginDisabled: '未启用登录保护',
		disableLoginConfirm: '关闭后任何人访问面板都不需要密码，确定继续？',
		logoutConfirm: '退出后本机需要重新登录，确定继续？',
		revokeAllConfirm: '所有设备都需要重新登录，确定继续？',
		logoutDialogContent: '当前这台设备的会话会立即作废，需要重新登录。',
		revokeAllDialogContent: '所有登录过的设备都会立即失效，需要重新登录。',
		enterCurrentPassword: '请输入当前密码',
		confirmPasswordChange: '确认修改',
		passwordChanged: '密码已修改，其它设备需重新登录',
		changePasswordFailed: '修改失败',
		loggedOut: '已退出登录',
		revokedAll: '已退出所有设备',

		// ── 数据（备份 / 迁移）──
		exportButton: '导出',
		importButton: '导入',
		chooseFile: '选择文件',
		exportNote: '备份文件里不会包含管理员密码。',
		importNote: '备份里不含管理员密码，导入后本机登录状态保持不变。',
		exported: '备份已导出',
		exportFailed: (message: string) => `导出失败：${message}`,
		overwriteTitle: '覆盖现有数据',
		overwriteConfirm: '当前所有分组与卡片都会被清空，然后写入备份里的内容。确定继续？',
		overwriteConfirmButton: '清空并导入',
		invalidBackup: '这个文件不是有效的 JSON，请选择本面板导出的备份文件',
		importDone: (groups: number, items: number, assets: number) =>
			`导入完成：${groups} 个分组、${items} 张卡片、${assets} 个图标 / 壁纸`,
		importCleared: '（原有卡片已清空）',
		importFailed: (message: string) => `导入失败：${message}`,
		importReloadFailed: '数据已导入，但界面刷新失败，请手动刷新页面',

		// ── 关于 ──
		restart: '重启',
		restartConfirm: '面板服务将重新启动，期间页面会短暂断连，确定继续？',
		restarted: '面板已重启',
		restartTimeout: '重启超时：请检查面板进程是否已启动',

		/**
		 * 软件更新（从 GitHub Releases 拉取）。
		 *
		 * 「当前 / 最新版本」的取值、进度百分比都由组件算好后传进来，
		 * 这里只负责措辞。更新失败（failed）会带上服务端原始报错；
		 * 检查失败只用固定文案，原因留给服务端日志，不往界面上堆。
		 */
		update: {
			title: '软件更新',
			/** 「关于」规格表里新增的一行 */
			kvLatest: '最新版本',
			check: '检查更新',
			apply: '立即更新',
			releaseNotes: '发布说明',
			/** 还没检查过 / 检查被跳过 */
			unknown: '尚未检查',
			upToDate: (tag: string | null) => (tag ? `已是最新版本 ${tag}` : '已是最新版本'),
			available: (tag: string) => `发现新版本 ${tag}`,
			/** 开发模式（bun run dev）下没有可替换的单文件产物 */
			devMode: '开发模式下无法自动更新，请更新源码后重启面板',
			confirm: (tag: string) => `将下载 ${tag} 并替换当前程序，面板会重启一次。确定继续？`,
			/** 更新过程的阶段文案；下载百分比未知时只显示「正在下载」 */
			phase: {
				downloading: (percent: number | null) =>
					percent === null ? '正在下载安装包…' : `正在下载安装包 ${percent}%`,
				verifying: '正在校验安装包…',
				installing: '正在替换程序文件…',
				restarting: '更新完成，正在重启面板…',
			},
			/** 下载量：已下载 / 总量（单位由 utils/format 统一换算） */
			progress: (received: string, total: string) => `${received} / ${total}`,
			/** 只报「失败」，不展示错误原因：这是给用户看的，不是给开发者看的 */
			checkFailed: '检查更新失败',
			/** 走了网页备用路径：说明为什么校验方式比 API 弱一点 */
			webHint: '更新清单不可用，已自动改用网页方式检查；下载后仍会校验文件大小与格式。',
			failed: (message: string) => (message ? `更新失败：${message}` : '更新失败'),
			updated: (tag: string) => `已更新到 ${tag}`,
		},

		// ── 保存反馈（label 用上面 labels / labelXxx 里的文案）──
		saved: (label: string) => `${label} 已保存`,
		saveFailed: (label: string) => `${label} 保存到服务端失败（已保留本地改动）`,
		persistFailed: (message: string) => `上次写入服务端失败：${message}`,
		networkModeSet: (mode: string) => `默认网络模式：${mode}`,
		autoModeOn: '已启用自动选择',
		autoModeOff: '已关闭自动选择',

		/** UI 风格说明，随所选风格变化；留空则不渲染 */
		glassStyleHint(style: GlassStyle): string {
			if (style === 'solid') return ''
			if (style === 'frost') return ''
			if (style === 'liquid') return '液态玻璃性能开销较大，可能引起卡顿'
			return ''
		},

		/** 卡片透明度说明：0 不透明、100 全透明，各风格的默认值不同；留空则不渲染 */
		glassTransparencyHint(style: GlassStyle): string {
			if (style === 'liquid') return ''
			if (style === 'solid') return ''
			if (style === 'frost') return ''
			return ''
		},
	},
} as const
