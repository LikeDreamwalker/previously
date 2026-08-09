# Strands

Strand 是一个关键词，贯穿每一个携带它的时间切片——它是构建在情景时间线之上的语义层。切片按时间说"发生了什么"，而 strand 按主题说"这是关于什么的"。

## 问题：情景记忆没有主题索引

时间切片按时间顺序组织你的历史。你可以问"昨天下午发生了什么"，然后找到对应的切片文件。但你无法轻易地问"所有我说过关于 Rust 的事情"——这个问题是*跨时间*的，而不是沿着时间的。

你需要两个坐标轴：

| 记忆类型 | 组织方式 | 单元 | 回答的问题 |
|---|---|---|---|
| **情景记忆** | 时间 | Slice | "什么时候发生了什么？" |
| **语义记忆** | 主题 | Strand | "关于 X 说过什么？" |

Strands 填补了语义轴。它们是按时间记录的切片在按主题维度的对应物。

## 工作原理

每个切片的 YAML frontmatter 中包含 `tags`——像 `"rust"`、`"async"`、`"deployment"` 这样的关键词。每当一个切片关闭时，这些标签会被编织进一个全局文件：

> `memory/episodic/strands.json`

该文件中的每个键是一个 **strand**（一个标签）。每个键的值是标记了该关键词的所有切片相对路径列表——"那个东西的完整历史"跨越时间。

```json
{
  "rust": [
    "2026/06/22/1400",
    "2026/07/01/0915",
    "2026/07/08/1630"
  ],
  "async": [
    "2026/06/22/1400"
  ],
  "deployment": [
    "2026/07/08/1630"
  ]
}
```

路径是相对的：没有 `slices/` 前缀，也没有 `.md` 扩展名。`sliceIdToRelPath` 将像 `2026-06-30-1430` 这样的切片 id 转换为 `2026/06/30/1430`，这样你就可以直接访问 `memory/episodic/slices/2026/06/30/1430.md`。

### 实时索引预览

```preview
demo: strands-index
```

## 派生而来，而非手动编写

Strands 没有单独的编写步骤。它们**完全派生自**每个切片 YAML frontmatter 中的 `tags` 数组。标签由 worker 模型在其维护更新中每轮维护——它读取对话、分类主题并写入标签。这些标签自动成为 strand。

这个循环是：

1. **worker 运行元数据维护** → 将 `tags` 写入当前活跃切片的 frontmatter
2. **切片被持久化**（在静默 30 分钟后关闭，或在对话中做快照）
3. **`updateStrands(slice)` 运行** → 读取 `strands.json`，将每个标签作为键合并，追加切片的相对路径（去重后），写回

标签编织成 strand。你永远不会直接编写 strand。

## Strands 何时写入

`updateStrands` 在两个地方运行：

- **切片关闭时**（`manager.ts` 中的 `closeSlice`）：在切片 `.md` 文件写入并且月度 `_index.json` 更新后，`updateStrands` 将切片的标签发布到全局索引中。
- **活跃切片快照时**（`manager.ts` 中的 `ensureIndexEntries`）：当对话进行中保存快照时，`updateStrands` 也会运行——但仅当该切片至少有一个标签时。这意味着进行中的切片在关闭前就会出现在 strand 索引中。

结果是：即使是活跃切片，`strands.json` 也始终保持最新，因此回忆扫描永远不会因为切片尚未关闭而错过某个标签。

## 类型定义

`StrandIndex` 类型（定义在 `src/lib/episodic/types.ts` 中）是一个普通的字符串键映射：

```typescript
interface StrandIndex {
  [strand: string]: string[];
}
```

如果 `strands.json` 还不存在——即没有任何切片有过标签——`readStrands()` 返回一个空对象 `{}`。写入总是通过 `JSON.stringify(index, null, 2)` 生成美化打印的 JSON。

## 双存储

读写路径通过 `fsReadFile`/`fsWriteFile` 包装器进行，它们在开发环境下透明地操作本地文件系统，在生产环境下则操作 GitHub API。strand 索引本身（`strands.json`）是一个运行时数据工件——它与切片位于同一个 memory 仓库中，而不是在应用源码树中。此代码仓库的工作树中不包含任何已提交的 `strands.json`。

## Strands 还不是什么（尚未实现）

截至 v0.7，strand 索引是**只写**的。它被构建和维护，但尚无任何回忆代码以编程方式读取 `strands.json` 来驱动 worker 的回忆扫描。唯一将 strand 暴露给模型的路径是添加到主模型上下文中的一条提示：

> "Use readStrand to explore `memory/episodic/strands.json` if deeper context is needed."

这意味着 strand 索引是准确且最新的，但尚未被自动查询。主模型必须选择通过 `readStrand` 工具打开这个文件。系统信任主模型来导航索引、挑选相关的 strand，并沿着它们的路径找到实际的切片文件。

一个更丰富的**一等公民 strand**——拥有自己的滚动摘要、自己的元数据，并直接集成到回忆管道中——是一个明确的未来里程碑。当前的 strand 仅是一个轻量、无损的索引：从关键词到切片路径的映射，仅此而已。

## 目前唯一的产物

今天基于主题索引的唯一代码产物是 worker 模型输出中的 `suggested_topics` 字段，它没有下游消费者。Strands 是唯一的生产级语义索引。基于主题的索引——比关键词路径更丰富，拥有自己的摘要和元数据——已列入路线图作为未来的里程碑。

## 相关文档

- [Slices](/content/docs/zh/slices) — 情景记忆对应物：按时间发生了什么
- [Timeline](/content/docs/zh/timeline) — 跨天和月的切片纵向视图
- [Recall](/content/docs/zh/recall) — worker 和主模型如何导航记忆
- [Memory Model](/content/docs/zh/memory-model) — 三层架构
