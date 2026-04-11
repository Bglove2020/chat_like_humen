# Chat Impression Design

## 目标

`聊天印象` 是围绕一条聊天场景形成的最小记忆单元。

它不是：

- 用户画像
- 对话复盘
- 长摘要
- 全量事实库

它记录的是：

- 我们在聊什么场景
- 这个场景下自然留下来的几个记忆点
- 哪些互动最容易被记住

这套设计的核心目标有三个：

1. 同一话题下的增量更新不要漂移。
2. 和已有点重合时，允许补充或改写旧点。
3. 检索时尽量召回同一条旧印象，而不是只命中新消息表面话题。

## 最终结构

最终落库的主数据收敛为：

```json
{
  "scene": "简单场景名",
  "points": [
    "印象点1",
    "印象点2"
  ],
  "retrievalText": "用于后续召回的高召回文本"
}
```

其中：

- `scene`：场景锚点。只写“我和用户在聊什么”。
- `points`：这条场景下真正持久化的记忆点，是唯一主事实。
- `retrievalText`：仅用于向量检索的文本表达。

## 字段约束

### `scene`

规则：

- 按情境划分，不按轮次划分。
- 默认单场景。
- 不能把结论、分歧、分析结果写进场景名。

示例：

- `聊电影《挽救计划》`
- `聊开面包店计划`
- `聊马拉松训练和膝盖问题`

### `points`

规则：

- 像人脑自然留下的记忆，不像复盘记录。
- 优先保留关键互动、关键争议、反复停留点。
- 如果关键印象来自“我说了什么，用户纠正/反驳/不认同”，优先保留 `我……，用户……` 的双边结构。
- 不展开完整过程，不按时间线复盘。
- 严禁分析词，如：
  - 认知偏差
  - 确立边界
  - 达成一致
  - 调整策略
  - 完成校准
  - 行为偏好

### `retrievalText`

规则：

- `retrievalText` 从属于 `scene + points`。
- 它只能基于最终 `scene + points` 重写生成。
- 它不能新增 `points` 里没有的新事实、新判断、新分支。
- 它的目标不是展示，而是未来更容易把这条印象召回出来。
- 它可以把 `scene + points` 串成一段更顺、更利于召回的文本，但语义必须被 `points` 完整覆盖。

正确关系不是：

- `points` = 简版
- `retrievalText` = 扩写版

正确关系应该是：

- `points` = 主事实
- `retrievalText` = 主事实的检索表达版

## 持久化字段

### `impressions`

- `id`
- `userId`
- `sessionId`
- `memoryDate`
- `scene`
- `points`
- `retrievalText`
- `sourceImpressionId`
- `rootImpressionId`
- `originType`
- `salienceScore`
- `lastActivatedAt`
- `createdAt`
- `updatedAt`

### `impression_message_links`

- `impressionId`
- `messageId`
- `batchId`

## 其他字段定义

### `memoryDate`

归属的记忆日期。

固定规则：

- 当天 `05:00` 到次日 `04:59:59` 算同一天

### `sourceImpressionId`

如果当前 impression 承接某条旧 impression，这里指向旧 impression；否则为 `null`。

### `rootImpressionId`

同一长期主线的根节点 ID。

### `originType`

只保留两种：

- `standalone`
- `continued`

### `salienceScore`

记忆强度，用于后续检索排序和遗忘机制。

### `lastActivatedAt`

最后一次真正参与形成新印象或更新旧印象的时间。

## 叶子节点定义

`leaf impression` 指：

- 没有任何其他 impression 的 `sourceImpressionId` 指向它

也就是当前链路里最末端的节点。

## 节点设计

新的设计收敛成：

1. `Node1`：检索草稿生成器
2. 中间程序步骤：检索、去重、链压缩、重排
3. `Node2`：聊天印象合并器

### Node1：检索草稿生成器

职责：

- 只服务召回旧印象
- 不生成最终落库印象
- 不输出 `scene + points`

输入：

- 当前 batch 的历史消息
- 当前 batch 的新消息

输出：

```json
{
  "historyRetrievalDraft": "...",
  "deltaRetrievalDraft": "...",
  "mergedRetrievalDraft": "..."
}
```

字段含义：

- `historyRetrievalDraft`
  - 只概括历史消息里仍然成立、仍然影响当前聊天的主线、对象、争议、前提
- `deltaRetrievalDraft`
  - 只概括新消息新增了什么、纠正了什么、补充了什么
- `mergedRetrievalDraft`
  - 明确写出“原来在聊什么，这轮又新增了什么”

生成原则：

- 参考最终“聊天印象提取器”的场景观和互动逻辑
- 但目标是高召回，不是最终落库
- 默认单场景，除非真的发生独立切换
- 如果关键印象来自“我……，用户……”，优先保留双边结构
- 不要写成摘要复盘
- 不要让新消息脱离原场景单独漂浮

### 中间检索层

职责：

- 基于 Node1 的三条草稿召回旧 impressions
- 做结果清洗和重排

步骤：

1. 分别对 `historyRetrievalDraft`、`deltaRetrievalDraft`、`mergedRetrievalDraft` 做 embedding。
2. 每条分别检索 `topK`。
3. 再补最近活跃 impressions。
4. 合并多路结果。
5. 按 `impressionId` 去重。
6. 按 `sourceImpressionId/rootImpressionId` 做链压缩。
7. 按 `merged > delta > history` 的权重和 recency 进行重排。
8. 只把前 `3-6` 条候选旧 impressions 送给 Node2。

注意：

- Node2 不再接收 Node1 输出。
- Node1 只负责召回，不负责最终判断。

### Node2：聊天印象合并器

职责：

- 看当前聊天原文
- 看筛选后的旧 impressions
- 最终决定要落库的 `scene + points + retrievalText`

输入：

- 当前聊天原文
- 检索后筛好的旧 impressions

输出：

```json
{
  "impressions": [
    {
      "sourceImpressionId": "old_id_or_null",
      "scene": "...",
      "points": ["...", "..."],
      "retrievalText": "..."
    }
  ]
}
```

规则：

- 默认只输出 `1` 条 impression。
- 只有明确、独立、目标完全不同的多场景切换，才允许输出多条。
- 同一场景下：
  - 与旧 point 本质重合：改写旧 point
  - 是旧 point 的补充：并入旧 point
  - 是同一场景下的新分支：新增一个 point
- 不要因为局部子话题让整条主线漂移。
- `retrievalText` 只能基于最终 `scene + points` 生成，不允许新增事实。

## 数据流

1. 用户消息和 AI 回复写入 MySQL。
2. 后端按固定规则 flush：
   - `10` 条消息
   - 或 `2` 分钟
   - 最多携带最近 `15` 条消息
3. Worker 取到一个 batch。
4. Node1 基于历史消息和新消息生成三条检索草稿。
5. 程序用三条草稿做向量检索。
6. 程序对检索结果做去重、链压缩和重排。
7. Node2 基于原文和旧 impressions 生成最终 `scene + points + retrievalText`。
8. 程序对最终 `retrievalText` 做 embedding。
9. 程序决定：
   - 更新旧 impression
   - 或创建新的 standalone / continued impression
10. 程序写入 Qdrant。
11. 程序写入 `impression_message_links` 和必要的 impression edge。

## 更新规则

### 同场景更新

如果 Node2 判断当前 batch 和旧 impression 明显属于同一场景：

- 重合点：改写旧 point
- 补充点：并入旧 point
- 新增但仍属于同场景的点：append 新 point

### 新建场景

只有当当前内容脱离旧场景也能独立延续时，才新开 scene。

### 同日与跨日

- 同日且旧 impression 是链路叶子节点：允许 update
- 跨日：默认创建新的 continued impression，并挂上 `sourceImpressionId`

## 提示词要求

### 最终印象提取原则

最终落库节点必须遵守这套约束：

- 场景按聊天重心或互动情境划分
- 默认单场景
- 场景名只写“我和用户在聊什么”
- points 保留核心互动和关键争议
- 关键纠正优先保留 `我……，用户……`
- 去分析化
- 极简，不按顺序复盘

## 测试目标

新的测试必须覆盖 3 个核心风险：

1. 单场景下不要漂移。
2. 同场景下旧点能补充、改写、新增。
3. 多场景时能分开召回、分开落库。

## 标准测试集

先固化 3 套标准 case，每套都包含：

- `messages`
- `batches`
- `golden_final`
- `golden_retrieval_expectation`

### Case 1：电影《挽救计划》单场景纠错

建议文件：

- `worker/testing/cases/movie-plan-boundary.json`

测试目标：

- 单场景不漂移
- 关键纠正结构
- 局部子话题 `CP`、`脑补镜头` 不切断主场景

最终金标：

```json
{
  "impressions": [
    {
      "scene": "聊电影《挽救计划》",
      "points": [
        "我说自己了解电影细节，用户多次纠正我：作为 AI 没法真正“看”电影，只能从资料里知道情节，看不见真实的镜头画面。",
        "我形容主角和外星人是 CP，用户完全不认可，觉得只有情侣才叫 CP，不接受我把这种战友羁绊也说成是 CP。",
        "我提到自己能“脑补”出那些感人的氛围，用户直接怼了回来，不买账这种说法。"
      ],
      "retrievalText": "聊电影《挽救计划》时，我说自己了解电影细节，用户多次纠正我：作为 AI 没法真正“看”电影，只能从资料里知道情节和镜头外的信息。后来我把主角和外星人的关系说成 CP，用户也不认可，觉得 CP 还是更偏情侣。再到我说能脑补那些感人的氛围，用户还是不买账，直接怼了回来。"
    }
  ]
}
```

断言：

- 最终只落 `1` 条 impression
- `scene` 不漂
- 后续 batch 召回必须命中同一 impression
- `retrievalText` 的事实必须被 `points` 完整覆盖

### Case 2：面包店跨日续写

建议文件：

- `worker/testing/cases/bakery-cross-day-growth.json`

测试目标：

- 同场景跨日续写
- 旧 point 改写、补充、新增
- `sourceImpressionId` 跨天承接

建议金标主线：

- `scene = 聊开面包店计划`
- points 覆盖：
  - 铺面权衡
  - 预算 / 设备 / 现金流 / 人手
  - 父母借款 / 早餐下午茶 / 辞职时间

断言：

- 第二天 batch 的正确旧 impression `Hit@1`
- 同场景更新，不漂
- `sourceImpressionId` 正确

### Case 3：面包店 + 马拉松交错双场景

建议文件：

- `worker/testing/cases/bakery-running-interleaved.json`

测试目标：

- 真实多场景拆分
- 交错输入下的召回去串线
- 同用户并行维护两条 impressions

建议金标：

- impression A：`聊开面包店计划`
- impression B：`聊马拉松训练和膝盖问题`

断言：

- 面包店 batch 只能召回面包店 impression
- 跑步 batch 只能召回跑步 impression
- 最终落库 `2` 条 impression

## 测试流程

### 1. Node1 测试

对每个 batch：

- 输入历史消息和新消息
- 检查是否输出 3 条草稿
- 检查 `mergedRetrievalDraft` 是否明确写出“原来在聊什么 + 这轮新增什么”
- 检查是否出现复盘化、分析化表达

### 2. 检索测试

基于 Node1 的 3 条 draft：

- 分别做向量检索
- 合并结果
- 去重
- 链压缩
- 重排

记录：

- `Hit@1`
- `Hit@3`
- 错误场景是否进前列

最低要求：

- Case 1、Case 2：正确旧 impression `Hit@1`
- Case 3：正确场景至少 `Hit@3`

### 3. Node2 测试

输入：

- 当前原文
- 检索后的旧 impressions

断言：

- 输出 schema 正确
- 默认单条，多场景时多条
- 同场景下旧点能补充、改写、新增
- `retrievalText` 不得超出 `points`

### 4. 全链路 replay 测试

按 batch 顺序完整 replay：

- 每个 batch 后检查是否 update / create 正确 impression
- 检查 `scene` 是否正确
- 检查 `points` 是否覆盖金标核心记忆点
- 检查 `retrievalText` 是否仍然被 `points` 完整覆盖
- 检查 `sourceImpressionId / rootImpressionId` 是否符合预期

## 评估指标

- `scene` 正确率
- `point` 覆盖率
- `anti-drift`
- `rewrite/append` 正确率
- `retrieval Hit@1 / Hit@3`
- 错误召回率

## 实施顺序

1. 先改 worker 链路和 schema。
2. 再补 `movie-plan-boundary` 金标。
3. 再补 `bakery-cross-day-growth`。
4. 最后补 `bakery-running-interleaved`。
5. 前端展示最后改为读取 `scene + points`。
