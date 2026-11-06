/**
 * 采析绘表格的列顺序。
 *
 * 两类列：
 * - **平台专属**（WEIBO_ / XHS_ / DOUYIN_ / TWITTER_ / BILIBILI_）：与采析绘 Selenium 版同名同序，
 *   同一个平台的两种引擎产出的表可以喂给同一批分析节点。
 * - **通用**（ITEM_ / USER_ / COMMENT_ …）：CatBus 独有模式（粉丝列表、热搜词、直播间、收藏夹……）
 *   没有 Selenium 对应表，用一套按归一化类型定义的列；各平台共用，不另造方言。
 *
 * 列名是下游分析节点的输入契约，改名等于让图读不到列，所以这里是常量而不是拼出来的。
 */

export const ITEM_COLUMNS = [
  '平台',
  '作品ID',
  '类型',
  '标题',
  '正文',
  '作者',
  '作者ID',
  '作者主页',
  '发布时间',
  '链接',
  '播放数',
  '点赞数',
  '评论数',
  '收藏数',
  '转发数',
  '图片数',
  '视频数',
]

export const USER_COLUMNS = ['平台', '用户ID', '昵称', '账号', '主页', '简介', '粉丝数', '关注数', '作品数', '获赞数']

export const COMMENT_COLUMNS = [
  '平台',
  '文章URL',
  '评论者',
  '评论者主页',
  '评论内容',
  '评论时间',
  '点赞数',
  '回复数',
  '楼层',
  '评论ID',
  '父评论ID',
]

export const KEYWORD_COLUMNS = ['平台', '关键词', '热度', '排名']
export const TOPIC_COLUMNS = ['平台', '话题ID', '话题', '链接', '浏览数', '作品数']
export const LIVE_COLUMNS = ['平台', '直播间ID', '标题', '主播', '主播主页', '状态', '观看人数', '链接', '封面']
export const FOLDER_COLUMNS = ['平台', '收藏夹ID', '名称', '数量', '链接']
export const SERIES_COLUMNS = ['平台', '合集ID', '名称', '数量', '链接']
export const CATEGORY_COLUMNS = ['平台', '分类ID', '名称', '父分类ID']
export const NOTICE_COLUMNS = ['平台', '通知ID', '类型', '用户', '用户主页', '内容', '目标ID', '目标链接', '时间']
export const POI_COLUMNS = ['平台', '地点ID', '名称', '地址']
export const CONVERSATION_COLUMNS = ['平台', '会话ID', '对方', '对方主页', '未读数', '最后消息', '更新时间']
export const MESSAGE_COLUMNS = ['平台', '消息ID', '会话ID', '发送者', '发送者主页', '类型', '内容', '时间']
export const MEDIA_COLUMNS = ['平台', '媒体ID', '类型', '地址', '宽', '高', '时长秒']
export const RANK_COLUMNS = ['平台', '排名', '用户', '用户主页', '分数']
export const GIFT_COLUMNS = ['平台', '礼物ID', '名称', '价格', '币种']
export const DANMAKU_COLUMNS = ['平台', '弹幕ID', '作品ID', '偏移秒', '内容', '时间']

// ─── 平台专属：与采析绘 Selenium 版一致 ──────────────────────────────────

export const WEIBO_POST_COLUMNS = [
  '发布者',
  '发布时间',
  '发布来源',
  '正文',
  '转发数',
  '评论数',
  '点赞数',
  '图片链接',
  '图片数',
  '话题',
  '视频数',
  '用户链接',
  '链接',
  '微博ID',
]

export const WEIBO_COMMENT_COLUMNS = ['平台', '文章URL', '评论者', '评论者主页', '评论内容', '评论时间', '点赞数', '楼层', '父楼层', '评论ID']

export const XHS_NOTE_COLUMNS = ['笔记链接', '笔记ID', '标题', '作者', '点赞数', '正文', '发布时间', '收藏数', '评论数', '评论列表']

export const XHS_COMMENT_COLUMNS = [
  '平台',
  '文章URL',
  '评论者',
  '评论者主页',
  '评论内容',
  '评论时间',
  '点赞数',
  '楼层',
  '评论ID',
  '父评论ID',
  '子回复数',
]

export const DOUYIN_VIDEO_COLUMNS = [
  '标题',
  '正文',
  '作者',
  '粉丝数',
  '获赞数',
  '发布时间',
  '视频ID',
  '点赞数',
  '评论数',
  '收藏数',
  '转发数',
  '链接',
]

export const DOUYIN_COMMENT_COLUMNS = [
  '平台',
  '文章URL',
  '评论者',
  '评论者主页',
  '评论内容',
  '评论时间',
  '评论地区',
  '点赞数',
  '子回复数',
  '楼层',
  '父楼层',
  '评论ID',
  '父评论ID',
]

export const TWITTER_POST_COLUMNS = [
  '发布者',
  '发布者ID',
  '用户链接',
  '发布时间',
  '正文',
  '话题',
  '评论数',
  '转发数',
  '点赞数',
  '收藏数',
  '浏览数',
  '图片链接',
  '图片数',
  '视频数',
  '是否引用',
  '含外链卡片',
  '含投票',
  '链接',
  '推文ID',
]

export const TWITTER_COMMENT_COLUMNS = [
  '平台',
  '文章URL',
  '评论者',
  '评论者昵称',
  '评论者主页',
  '评论内容',
  '评论时间',
  '点赞数',
  '回复数',
  '转发数',
  '浏览数',
  '图片链接',
  '图片数',
  '是否引用',
  '楼层',
  '评论ID',
  '推文ID',
]

/** 归一化输出类型 → 通用列。清单生成与通用处理器都读这一份。 */
export const OUTPUT_COLUMNS: Record<string, string[]> = {
  Item: ITEM_COLUMNS,
  User: USER_COLUMNS,
  Comment: COMMENT_COLUMNS,
  Keyword: KEYWORD_COLUMNS,
  Topic: TOPIC_COLUMNS,
  Live: LIVE_COLUMNS,
  Folder: FOLDER_COLUMNS,
  Series: SERIES_COLUMNS,
  Category: CATEGORY_COLUMNS,
  Notice: NOTICE_COLUMNS,
  Poi: POI_COLUMNS,
  Conversation: CONVERSATION_COLUMNS,
  Message: MESSAGE_COLUMNS,
  Media: MEDIA_COLUMNS,
  Rank: RANK_COLUMNS,
  Gift: GIFT_COLUMNS,
  Danmaku: DANMAKU_COLUMNS,
}

/** 可以被采集器当成表格交出去的输出类型；其余（AuthStatus/File/Event/Order…）不进清单。 */
export const TABLE_OUTPUTS = new Set(Object.keys(OUTPUT_COLUMNS))
