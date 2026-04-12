# Memory Architecture v1 方案

## 一、总目标

这套方案的核心是：

- `point` 是唯一真实记忆
- `line` 是 `point` 的归属容器
- `impression` 只是 `line` 上的高层派生字段
- `Node2` 只生成 `points`
- 独立 `new point` 再经过单独节点判断是否属于已有 `line`
- 未归属的 `new points` 再统一生成新的 `lines`
- 最后独立重算 `impression`

## 二、核心概念

### 1. point

唯一真实记忆，唯一增量更新单位。

负责承载：

- 新增
- 补充
- 修正
- 冲突

### 2. line

一组长期相关 `points` 的归属容器。

特点：

- 不是线性链表
- 内部自然形成森林
- 不加虚拟根节点
- 一个 `line` 内可以有多个顶层 `point`

### 3. impression

不是独立主记忆，不参与直接召回。  
它只是 `line` 上的高层背景字段。

它的作用是：

> 当某个 `point` 被召回时，把它所属 `line` 的高层背景一起返回。

## 三、总体原则

### 原则 1

`point` 是 source of truth。

### 原则 2

`line` 只是归属容器，不是 LLM 直接生成的主内容对象。

### 原则 3

`impression` 是 `line` 的派生字段，不是底层主事实。

### 原则 4

跨天允许延续，不允许跨天直接覆盖旧 `point`。

### 原则 5

同日允许原位更新，但必须保留 revision log。

### 原则 6

`impression` 只看 `line` 当前叶子 `points` 进行重算。

## 四、数据结构

### 1. `memory_lines`

```ts
type MemoryLine = {
  id: string;
  userId: number;
  sessionId?: string | null;

  anchorLabel: string;          // 稳定锚点，line 的长期主题名
  impressionLabel: string;      // 当前高层标题
  impressionAbstract: string;   // 当前高层背景
  impressionVersion: number;

  salienceScore: number;
  lastActivatedAt: string;

  createdAt: string;
  updatedAt: string;
};
```

#### 字段说明

- `anchorLabel`：较稳定，不应频繁漂移
- `impressionLabel`：当前 line 的高层概括
- `impressionAbstract`：当前背景描述
- `impressionVersion`：每次重算 `+1`

### 2. `memory_points`

```ts
type MemoryPoint = {
  id: string;
  userId: number;
  sessionId?: string | null;

  lineId: string;

  op: 'new' | 'supplement' | 'revise' | 'conflict';
  sourcePointId?: string | null;

  text: string;                 // 当前 point 的最终保存文本

  memoryDate: string;           // 按 05:00 切日规则
  salienceScore: number;

  createdAt: string;
  updatedAt: string;
};
```

#### 字段说明

- `sourcePointId`：只表示“是否直接承接某个旧 point”
- 它**不表示 line 归属**
- line 归属由 `lineId` 决定

### 3. `point_revision_logs`

```ts
type PointRevisionLog = {
  id: string;
  pointId: string;

  beforeText: string;
  afterText: string;

  batchId: string;
  createdAt: string;
};
```

#### 作用

记录同日原位更新时的历史版本。

### 4. `point_message_links`

```ts
type PointMessageLink = {
  pointId: string;
  messageId: string;
  batchId: string;
};
```

#### 作用

把 point 和原始消息证据关联起来，便于调试和追溯。

## 五、Node2 输出协议

Node2 只负责生成 points，不负责 line 归属，也不负责 impression。

### 输出格式

```json
[
  {
    "op": "new | supplement | revise | conflict",
    "sourcePointId": "旧 point id 或 null",
    "text": "..."
  }
]
```

## 六、op 语义和硬约束

### 1. `new`

#### 含义

一个独立新点，不直接承接某个旧 point。

#### 约束

- `sourcePointId = null`

#### 说明

之后它可以：

- 并入某个已有 line
- 或创建一个新的 line

但这两件事都**不由 Node2 决定**。

### 2. `supplement`

#### 含义

旧 point 的核心仍成立，只是在其上补充关键信息。

#### 约束

- `sourcePointId != null`

#### 文本要求

输出的是“补充后的最终保存文本”，不是差异说明。

### 3. `revise`

#### 含义

旧 point 需要被修正成更准确版本。

#### 约束

- `sourcePointId != null`

#### 文本要求

输出的是“修正后的最终保存文本”。

### 4. `conflict`

#### 含义

当前信息和旧 point 的当前有效状态相冲突。

#### 约束

- `sourcePointId != null`

#### 文本要求

输出的是“新的冲突态文本”，不要只说“发生冲突”。

## 七、不同 op 的 text 生成规则

这部分建议直接写进 Node2 prompt，作为硬规则。

### 通用规则

所有 point 的 `text` 都要满足：

- 优先第一视角，尽量写成“我……，用户……”
- 一条 point 只保留一个主要互动单元
- 尽量自包含，单独拿出来也能理解
- 不写成转录体：不要 `用户：... 我：...`
- 不写分析词：不要“体现了”“说明了”“达成一致”“认知偏差”
- 不写过程流水账

### `new` 的 text

#### 要求

- 必须可以单独成立
- 不需要提“这是新话题”
- 直接写最值得留下的新互动

#### 例子

`我把两个人关系叫成 CP，用户明确不接受这种说法。`

### `supplement` 的 text

#### 要求

- 必须是“补充后的完整版本”
- 保留旧核心，再把新信息融进去
- 不要只写“用户又补充了一点”

#### 例子

旧点：

`我解释“搬砖”是打工人的自嘲说法。`

补充后：

`我解释“搬砖”是打工人的自嘲说法，用户继续追问这个叫法为什么会这样叫。`

### `revise` 的 text

#### 要求

- 必须是“修正后的最终版本”
- 如果“我被纠正”本身有价值，就保留这种张力
- 不要写元话语，比如“这个点被修正了”

#### 例子

`我先把“把尿喝白”当成谐音梗，用户纠正我：他说的是大量喝水让尿色变白。`

### `conflict` 的 text

#### 要求

- 必须明确表达当前冲突状态
- 单独看也能理解
- 可以带一点“之前 vs 现在”的张力

#### 例子

`我之前把这种关系叫成 CP，用户后面明确表示他并不接受这种叫法。`

## 八、整体执行链路

### 阶段 0：候选 line 检索

在进入“归属已有 line”节点前，先取候选 lines。

#### 候选来源

- 最近活跃 lines
- 向量检索匹配 lines
- 关键词筛选 lines

#### 每条候选 line 传给 LLM 的内容

- `lineId`
- `impressionLabel`
- `impressionAbstract`

默认不传整条 line 的所有 points。  
只有在需要辅助 source 对齐时，才附加极少量最近叶子 points 作为补充。

### 阶段 1：Node2 生成 points

#### 输入

- 历史消息
- 新消息
- 召回到的相关旧 points（用于 source 对齐）

#### 输出

- `new`
- `supplement`
- `revise`
- `conflict`

这里只做 point 生成，不做 line 判断。

### 阶段 2：处理有 source 的 points

对 `supplement / revise / conflict`：

1. 通过 `sourcePointId` 找到旧 point
2. 继承旧 point 的 `lineId`
3. 判断 source point 的 `memoryDate`

#### 若 source point 是今天的

- 原位更新 point
- 写 `point_revision_logs`

#### 若 source point 是历史日期

- 新增一条 point
- `sourcePointId` 指向旧 point
- `lineId` 继承旧 line

### 阶段 3：对独立 new points 做“归属已有 line”判断

这里只处理：

- `op = new`
- `sourcePointId = null`

#### 调用方式

**一个 new point 一次调用**，并行执行。

#### 输入

- 当前这个 `new point.text`
- 候选 lines 的 impression 信息

#### 输出

```json
{
  "targetLineId": "line_xxx 或 null"
}
```

#### 含义

- 有 `targetLineId`：这个 point 属于某个已有 line
- `null`：它不属于任何已有 line

### 阶段 4：将已归属点并入已有 line

对于 `targetLineId != null` 的 new point：

- 创建 point
- 挂到对应的 `lineId`

### 阶段 5：为剩余未归属 new points 生成新 lines

把所有 `targetLineId = null` 的 new points 收集起来，再调用一个**新 line 生成节点**。

这个节点不负责写 impression，只负责：

1. 这些点应该分成几组
2. 每组是什么新的 line
3. 每组的 `anchorLabel` 是什么

#### 输入

- 所有未归属的 new points 文本

#### 输出示例

```json
{
  "newLines": [
    {
      "anchorLabel": "聊《挽救计划》相关分歧",
      "pointIndexes": [0, 2]
    },
    {
      "anchorLabel": "聊网络说法解释",
      "pointIndexes": [1, 3]
    }
  ]
}
```

#### 执行层处理

- 每组创建一个新 line
- 每个 point 挂到对应 line

### 阶段 6：重算 dirty lines 的 impression

所有被修改过的 line，标记为 dirty。  
然后单独重算：

- `impressionLabel`
- `impressionAbstract`
- `impressionVersion`

这一步建议作为**独立阶段**，不要放进 Node2，也不要放进新 line 生成节点。

可以先同步实现，逻辑上独立；后续再拆成异步任务。

## 九、impression 的生成规则

### 设计定位

impression 不再是 `scene + impression points + retrievalText` 这种可检索结构。  
它只是 `line` 上的高层背景字段。

### 输入

某个 line 当前的**所有叶子 points**

### 叶子定义

没有任何其他 point 的 `sourcePointId` 指向它的 point。

### 为什么只看叶子

因为：

- 同日更新已经被 revision log 吸收
- 跨日变化会新增 child point
- 当前有效状态自然会沉淀在叶子上

### 输出字段

- `impressionLabel`
- `impressionAbstract`

### impression 生成要求

- 不平铺所有叶子
- 只提炼这条 line 当前最有价值的高层背景
- 更像“人脑最后留下的整体印象”
- 不写成复盘摘要
- 不写成长说明文
- 不参与直接向量检索

## 十、冷启动与无 line 场景

当系统里还没有任何已有 line 时：

- 阶段 3 直接跳过
- 所有 `new` 点直接进入阶段 5
- 由“新 line 生成节点”分组并生成第一批 lines

也就是说：

> 不是先有 line 再塞 point，  
> 而是先有一批新 points，再由模型把这些点分成若干组，每组长出一个新的 line。

## 十一、两个新节点的最终输出协议

### 节点 A：归属已有 line

```json
{
  "targetLineId": "line_xxx 或 null"
}
```

### 节点 B：新 line 生成

```json
{
  "newLines": [
    {
      "anchorLabel": "...",
      "pointIndexes": [0, 1]
    }
  ]
}
```

## 十二、可选兜底：轻量 sanity check

这个不是必须第一版就上，但后面建议加。

对“归属已有 line”节点返回的 `targetLineId`，执行层可以做两个很轻的检查：

1. 这个 `targetLineId` 必须真的在候选集合里
2. 当前 point 和该 line 的 impression 相似度不能低得离谱

如果不满足，就降级成 `null`。

这只是保险丝，不是第二套判定系统。

## 十三、建议的最小 SQL 表结构

### `memory_lines`

```sql
CREATE TABLE memory_lines (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  session_id TEXT NULL,
  anchor_label TEXT NOT NULL,
  impression_label TEXT NOT NULL,
  impression_abstract TEXT NOT NULL,
  impression_version INT NOT NULL DEFAULT 1,
  salience_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_activated_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
```

### `memory_points`

```sql
CREATE TABLE memory_points (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  session_id TEXT NULL,
  line_id UUID NOT NULL REFERENCES memory_lines(id),
  op TEXT NOT NULL,
  source_point_id UUID NULL REFERENCES memory_points(id),
  text TEXT NOT NULL,
  memory_date DATE NOT NULL,
  salience_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
```

### `point_revision_logs`

```sql
CREATE TABLE point_revision_logs (
  id UUID PRIMARY KEY,
  point_id UUID NOT NULL REFERENCES memory_points(id),
  before_text TEXT NOT NULL,
  after_text TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL
);
```

### `point_message_links`

```sql
CREATE TABLE point_message_links (
  point_id UUID NOT NULL REFERENCES memory_points(id),
  message_id TEXT NOT NULL,
  batch_id TEXT NOT NULL
);
```

## 十四、最小执行伪代码

```ts
const node2Points = await runNode2(...);

// 1. 先处理有 source 的点
for (const p of node2Points) {
  if (p.op !== 'new') {
    const source = await getPointById(p.sourcePointId!);
    const sameDay = source.memoryDate === currentMemoryDate;

    if (sameDay) {
      await updatePointInPlace(source.id, p.text);
      await insertRevisionLog(source.id, source.text, p.text, batchId);
      dirtyLineIds.add(source.lineId);
    } else {
      await createPoint({
        lineId: source.lineId,
        op: p.op,
        sourcePointId: source.id,
        text: p.text,
        memoryDate: currentMemoryDate
      });
      dirtyLineIds.add(source.lineId);
    }
  }
}

// 2. 处理独立 new points
const isolatedNewPoints = node2Points.filter(
  p => p.op === 'new' && p.sourcePointId == null
);

// 3. 单点判断是否属于已有 line
const unresolvedNewPoints = [];
for (const p of isolatedNewPoints) {
  const candidateLines = await recallCandidateLines(p.text);
  const route = await runAttachExistingLineNode(p.text, candidateLines);

  if (route.targetLineId) {
    await createPoint({
      lineId: route.targetLineId,
      op: 'new',
      sourcePointId: null,
      text: p.text,
      memoryDate: currentMemoryDate
    });
    dirtyLineIds.add(route.targetLineId);
  } else {
    unresolvedNewPoints.push(p);
  }
}

// 4. 剩余点生成新 lines
if (unresolvedNewPoints.length > 0) {
  const newLinePlan = await runCreateNewLinesNode(unresolvedNewPoints);

  for (const group of newLinePlan.newLines) {
    const line = await createLine({
      anchorLabel: group.anchorLabel,
      impressionLabel: '',
      impressionAbstract: ''
    });

    for (const idx of group.pointIndexes) {
      const p = unresolvedNewPoints[idx];
      await createPoint({
        lineId: line.id,
        op: 'new',
        sourcePointId: null,
        text: p.text,
        memoryDate: currentMemoryDate
      });
    }

    dirtyLineIds.add(line.id);
  }
}

// 5. 重算 dirty lines 的 impression
for (const lineId of dirtyLineIds) {
  const leafPoints = await getLeafPoints(lineId);
  const impression = await rebuildImpression(lineId, leafPoints);
  await updateLineImpression(lineId, impression);
}
```

## 十五、最终定稿版定义

> Node2 只负责生成 points；其中有来源的点自动继承 source 所在 line，并按“同日原位更新、跨日新增”的规则落库；独立 `new` points 先逐个判断是否属于某个已有 line，能归属的直接并入，不能归属的再统一分组生成新的 lines；最后只对受影响的 lines 重算 impression，而 impression 只是 line 的高层派生背景，不再作为直接召回对象。
