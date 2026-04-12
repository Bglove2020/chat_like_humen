# Chat Impression System Redesign

## 1. 目标重述

新的 `聊天印象` 不应再被视为“LLM 给当前 batch 写的一段摘要”。

它应该是：

- 可演化的记忆快照
- 有明确来源的客观记录
- 只保留未来对话可能有用的核心部分
- 默认以用户内容为主，必要时保留与未来对话强相关的 AI 内容
- 最终展示时使用 AI 第一视角

它不应该是：

- 长摘要
- 复盘
- 情绪化描述
- 对用户动机、心理、态度的推测
- 对对话摩擦、扯皮细节的逐句保留

一句话：

`聊天印象 = 客观事实层 + 演化关系层 + 第一视角渲染层`

当前系统的主要问题是，这三层被压扁成了 `scene + points + retrievalText` 一次性生成，所以模型必须同时负责：

- 判断什么值得记
- 判断和旧印象是什么关系
- 决定如何续写
- 决定如何用第一视角表达
- 决定如何写成检索文本

这会天然导致：

- 啰嗦
- points 粒度漂移
- 扯皮细节进印象
- 续写时只会“重写句子”，不会“基于旧印象演化”
- 第一视角和客观事实互相污染

## 2. 核心设计原则

### 2.1 第一视角只属于渲染层，不属于事实层

这是整个系统最关键的改动。

如果直接让模型在“事实提取阶段”就写成第一视角，它很容易把主观判断、态度词、过程词一起带进去。

正确做法应该是：

1. 先抽客观事实，不要求第一视角
2. 再判断和历史印象的关系
3. 最后单独把结果渲染成第一视角

这样才能同时满足：

- 客观
- 可追溯
- 可续写
- 第一视角自然

### 2.2 印象是“主题快照”，不是“消息压缩”

同一话题下，一个 batch 里出现的很多消息，本质上可能只形成 1 个记忆变化。

因此不应该把消息级细节直接映射到 point 数量。

point 的单位应该是：

- 一个可长期保留的核心互动
- 一个对未来对话仍有价值的状态
- 一个对已有印象形成修正、推进、收敛或补充的变化

### 2.3 续写不是整条改写，而是基于旧快照的演化

当天同一主线继续聊时，应该允许覆盖当天快照。

跨天继续聊时，不应该只新建一个“长得像旧印象的句子”，而应该明确：

- 和前一版是什么关系
- 是继续、收紧、补充、纠正，还是冲突补记

## 3. 新的记忆本体

建议把一条印象拆成 5 个概念。

### 3.1 Impression Thread

一条长期主线。

例如：

- 聊开面包店计划
- 聊电影《挽救计划》
- 聊马拉松训练和膝盖问题

当前系统里可以继续复用 `rootImpressionId` 表示 thread，不必立刻新建 MySQL 表。

### 3.2 Impression Revision

某个 thread 在某个时间点的快照版本。

当前系统里的每一条 Qdrant impression，本质上都应被视为 revision。

建议继续保留：

- `id`
- `sourceImpressionId`
- `rootImpressionId`
- `memoryDate`
- `originType`

但要补充“这版相对上一版发生了什么”。

### 3.3 Objective Facts

客观事实层，只记录可被原始消息直接支持的内容。

建议按数组存储，每条都带来源和类型。

示例：

```json
[
  {
    "kind": "user_plan",
    "text": "用户当前更偏向社区店而不是商场店",
    "evidenceMessageIds": [7],
    "sourceSide": "user"
  },
  {
    "kind": "constraint",
    "text": "家里愿意借启动资金，但这笔钱只够基础装修和前期设备",
    "evidenceMessageIds": [5, 7],
    "sourceSide": "user"
  }
]
```

### 3.4 Assistant Carry-Forward

单独存未来对话仍有用的 AI 内容。

只允许保留这类 AI 内容：

- 明确解释过的边界
- 明确约定过的推进方向
- 未来还会复用的分析框架

不允许保留：

- 空泛安慰
- 即时寒暄
- 一次性铺垫
- 对用户态度的感受描述

### 3.5 Relation To Previous

当前 revision 相对上一版的关系。

建议最少有两个字段：

- `relationType`
- `relationSummary`

其中 `relationType` 建议限定为：

- `continue`
- `refine`
- `expand`
- `correct`
- `branch`
- `conflict_note`

`relationSummary` 例子：

- 在之前的开店计划上，这次从“权衡铺面”收紧到了“社区店优先”
- 在之前纠正我不能说自己真正看过电影的基础上，这次又新增了用户对“CP”说法的不认可

## 4. 什么应该进入印象，什么不应该

### 4.1 应进入印象的内容

- 用户的长期计划、目标、顾虑、限制
- 用户明确表达的偏好、决定、变化
- 对未来对话有影响的纠正和边界
- 同一主题下逐渐收敛出来的核心状态
- 未来很可能被再次提起的 unresolved issue

### 4.2 不应进入印象的内容

- 单次寒暄
- 过程铺垫
- 情绪化摩擦本身
- “用户怼了我”“我接梗失败”这类态度化表述
- 只服务当前一句回复、对未来没有价值的细枝末节
- 不能形成稳定状态的瞬时表达

### 4.3 一个很重要的边界

有些“扯皮”本身不该记，但“扯皮背后的稳定边界”应该记。

例如：

- 不该记：`用户直接怼了回来，不买账这种说法`
- 应该记：`用户明确纠正我不能把基于资料的理解说成自己真正看过电影`

这意味着系统要抽取的是：

- 可复用的边界
- 不是边界发生时的情绪外观

## 5. 推荐的新链路

保留现有 Node1，但把现有 Node2 拆成三个更窄的阶段。

### 5.1 Node1 保留：Retrieval Draft

职责不变：

- 只服务旧印象召回
- 不负责最终表达

### 5.2 Node2A：Evidence Extractor

输入：

- `history_messages`
- `new_messages`

输出：

```json
{
  "candidates": [
    {
      "candidateId": "c1",
      "kind": "user_plan|preference|constraint|boundary|assistant_carry_forward|correction",
      "topic": "开面包店计划",
      "objectiveText": "用户当前更偏向社区店而不是商场店",
      "futureUsefulness": 0.92,
      "evidenceMessageIds": [7],
      "sourceSides": ["user"]
    }
  ]
}
```

规则：

- 不看旧 impression
- 不写 scene
- 不写第一视角
- 不写 retrievalText
- 只判断“有没有值得记住的客观变化”

### 5.3 Node2B：Thread Reconciler

输入：

- `candidates`
- `old_impressions`

输出：

```json
{
  "operations": [
    {
      "candidateId": "c1",
      "targetImpressionId": "old_id_or_null",
      "relationType": "refine",
      "action": "same_day_rewrite|cross_day_continue|new_thread|discard",
      "reason": "same thread, new state is narrower than previous"
    }
  ]
}
```

规则：

- 这里只判断关系和动作
- 不负责最后的文案
- 不允许直接自由改写旧 points

### 5.4 Node2C：Snapshot Renderer

输入：

- 上一版 revision
- 被接受的 candidates
- operations

输出：

```json
{
  "impressions": [
    {
      "sourceImpressionId": "old_id_or_null",
      "scene": "聊开面包店计划",
      "relationType": "refine",
      "relationSummary": "在之前的铺面权衡基础上，这次收紧成社区店优先。",
      "objectiveFacts": [
        {
          "kind": "user_plan",
          "text": "用户当前更偏向社区店而不是商场店",
          "evidenceMessageIds": [7]
        }
      ],
      "assistantCarryForward": [
        {
          "text": "我后续仍应围绕现金流和辞职时间继续推进",
          "evidenceMessageIds": [8]
        }
      ],
      "points": [
        "我在继续和用户聊开面包店计划；和之前只是在社区店与商场店之间权衡相比，用户现在更偏向社区店。",
        "用户的启动资金只够基础装修和前期设备，现金流和辞职时间仍是后续需要继续推进的核心问题。"
      ],
      "retrievalText": "聊开面包店计划。我之前已和用户讨论过铺面、预算和现金流，这次又明确了用户更偏向社区店，且启动资金只够基础装修和前期设备。"
    }
  ]
}
```

这里的关键是：

- `objectiveFacts` 是事实层
- `relationSummary` 是演化层
- `points` 是第一视角渲染层

## 6. 为什么这样更符合目标

### 6.1 客观

客观性不再依赖最终文案自觉，而是由 `objectiveFacts + evidenceMessageIds` 先锁死。

### 6.2 可溯源

当前只有 impression 级 message links。

建议进一步让每个 fact / carry-forward item 也显式挂 `evidenceMessageIds`。

这样后续可以回答：

- 这条 point 来自哪些消息
- 这个变化是本轮新增的，还是旧事实延续

### 6.3 可演化

通过 `relationType + relationSummary`，系统第一次真正表达出“这版是怎么从上一版长出来的”。

### 6.4 第一视角更稳定

第一视角不再承担“判断事实”的职责，只承担“把已确定的事实渲染成人话”的职责，稳定性会明显提高。

## 7. 对当前 replay case 的直接修正建议

当前 replay case 的金标能测“串线”和“续写”，但还没有完全测到新的目标。

至少要新增下面三类断言。

### 7.1 去情绪化断言

禁止进入最终 `points` 的词：

- 怼
- 不买账
- 接梗失败
- 乱说
- 情绪上头

除非这些词本身就是未来会再次被讨论的稳定对象，否则它们不该进入印象。

### 7.2 演化表达断言

跨天 `continued` 的 revision 必须能回答：

- 这次相对上一版是继续、收紧、补充还是纠正

不能只验证 `sourceImpressionId` 存在。

### 7.3 事实来源断言

最终 point 必须至少能映射回一条用户消息。

如果 point 只由 AI 内容支撑，它只能进入 `assistantCarryForward`，不能成为主 point。

## 8. 对当前 prompt 的判断

当前 prompt 已经做了两件对的事：

- 强调原始消息优先
- 强调旧印象只用于稳定和对账

但它仍然有三个根本不足：

### 8.1 让一个节点同时做太多事情

尤其当前 Node2 要同时做：

- 取舍 candidate
- 匹配旧 impression
- 决定续写方式
- 生成 final points

这会把错误耦合到一起。

### 8.2 缺少“应丢弃什么”的更强约束

现在虽然写了“不要摘要化”，但还没把“扯皮细节不应该进印象”变成结构化判定条件。

### 8.3 没有把第一视角和事实层剥离

这会导致模型为了保持“我”视角，顺手写入态度词和过程词。

## 9. 对 mem0 的建议

如果目标是“可演化、可溯源、客观、少噪音”，当前外部 mem0 不应直接参与主链路。

原因很简单：

- 它是黑盒
- 事实粒度不可控
- 演化关系不可控
- 可追溯性不可控

建议：

1. 线上上下文主链路只用自研 impression + structured profile
2. mem0 仅保留为 compare baseline 或离线实验项
3. 如果未来还想保留“开放式偏好记忆”，也应走和 impression 类似的两层结构：
   - `profile_events`
   - `profile_state`

而不是“抽到一条碎片就直接作为 active memory”

## 10. 建议的数据字段增量

在不打破当前接口的情况下，先给 Qdrant payload 增加这些字段：

- `relationType`
- `relationSummary`
- `objectiveFacts`
- `assistantCarryForward`
- `pointMeta`

其中 `pointMeta` 至少包含：

- `kind`
- `evidenceMessageIds`
- `sourceSides`

这样可以先兼容旧接口：

- 对外仍返回 `scene + points + time`

但内部已经拥有下一步升级所需的信息。

## 11. 质量闸门

落库前建议增加硬规则。

### 11.1 point 数量

- 默认最多 `2`
- 很少情况下允许 `3`
- 超过则强制要求压缩

### 11.2 单条 point 长度

- 中文建议不超过 `80-100` 字

### 11.3 主体要求

- 每条主 point 至少包含一个用户事实
- AI 侧信息只能作为补充，不可喧宾夺主

### 11.4 禁止词

- 说明了
- 体现出
- 反映出
- 怼
- 接梗失败
- 认知偏差
- 确立边界
- 达成一致
- 完成校准

### 11.5 证据完整性

- 若无法映射到 `evidenceMessageIds`，直接拒绝落库

## 12. 评估方式

下一轮迭代不能只看“读起来像不像”，而要建立更清晰的评估集。

建议每个 replay case 同时维护四类金标：

- `expected_thread`
- `expected_relation`
- `expected_objective_facts`
- `expected_rendered_points`

核心指标建议改为：

- `thread continuity accuracy`
- `relation type accuracy`
- `fact traceability coverage`
- `noise rejection precision`
- `first-person render compliance`
- `retrieval Hit@1 / Hit@3`

## 13. 落地顺序

### Phase 1：先改标准，不急着改大架构

- 新增 replay 金标：去情绪化、演化关系、事实来源
- 重新定义“什么应该进印象”
- 停止把 mem0 结果注入主链路

### Phase 2：改 Node2 拆分

- `Evidence Extractor`
- `Thread Reconciler`
- `Snapshot Renderer`

### Phase 3：补字段和质量闸门

- 新增 `relationType / relationSummary / objectiveFacts / pointMeta`
- 加落库前硬校验

### Phase 4：再做 prompt 精修

到这一步再调 prompt，效率会高很多，因为系统边界已经清楚了。

## 14. 最重要的结论

这次优化不应该再从“怎么让 prompt 更像人写的印象”开始。

应该从下面这个顺序开始：

1. 先定义什么是印象，什么不是印象
2. 再定义印象如何演化
3. 再定义事实层和第一视角渲染层的关系
4. 最后才是 prompt 和文案风格

如果顺序反过来，系统会继续在“句子更顺了，但本体仍然错了”这个层面来回打转。
