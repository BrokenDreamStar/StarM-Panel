/**
 * 项目标识与仓库地址。
 *
 * 页脚的品牌链接与更新功能的默认仓库都从这里取，避免仓库名在两处各写一遍。
 * 注意两者语义不同：更新源可以用 `STARM_UPDATE_REPO` 指向 fork 或镜像，
 * 页脚链接则永远指向上游项目 —— 面板被二次分发时，页脚不该把人带到别处。
 */
export const PROJECT_REPO_SLUG = 'BrokenDreamStar/StarM-Panel'

/** 项目主页（页脚「Powered By StarM Panel」的链接目标） */
export const PROJECT_REPO_URL = `https://github.com/${PROJECT_REPO_SLUG}`
