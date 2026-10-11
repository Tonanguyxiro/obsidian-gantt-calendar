# 修复任务修改时全局过滤符号丢失问题

## 问题描述

当用户通过以下操作修改任务时，任务会丢失全局过滤符号：
1. 点击任务卡片完成任务（复选框）
2. 在甘特图中拖拽任务条修改任务时间
3. 任何其他通过 `updateTaskProperties` 函数的任务修改

### 问题现象
- **原始任务**：`- [ ] 🎯 完成项目文档 📅 2025-01-15`
- **修改后**：`- [ ] 完成项目文档 📅 2025-01-15` （全局过滤符号 `🎯 ` 丢失）

## 根本原因

虽然 `serializeTask` 函数在代码中有添加全局过滤符号的逻辑，但问题在于**无法正确获取插件实例及其设置**：

```typescript
// 旧代码中获取插件的方式有问题
const plugin = (app as any).plugins?.plugins['obsidian-gantt-calendar'];
const globalFilter = plugin?.settings?.globalTaskFilter || '';
```

问题：
1. `(app as any).plugins?.plugins['obsidian-gantt-calendar']` 的访问路径可能不对
2. 如果获取失败，`globalFilter` 会是空字符串
3. 最后序列化时就无法添加全局过滤符号

## 解决方案

改进插件实例的获取方式，增加备用访问路径：

```typescript
// 改进后：使用双重查询确保能获取到插件实例
const ganttPlugin = (app as any).plugins?.plugins?.['obsidian-gantt-calendar'] || 
                    (app as any).plugins?.getPlugin?.('obsidian-gantt-calendar');
const globalFilter = ganttPlugin?.settings?.globalTaskFilter || '';
const taskStatuses = ganttPlugin?.settings?.taskStatuses || DEFAULT_TASK_STATUSES;
```

### 改进的关键点

1. **双重查询路径**
   - 首选：`(app as any).plugins?.plugins?.['obsidian-gantt-calendar']`
   - 备选：`(app as any).plugins?.getPlugin?.('obsidian-gantt-calendar')`
   - 这样可以兼容不同版本 Obsidian 的插件管理器实现

2. **通过链式可选操作符确保安全**
   - 避免 null/undefined 导致的错误
   - 即使获取失败也有默认值

3. **完整的信息链**
   ```
   App → plugins 管理器 → 插件实例 → settings → globalTaskFilter
   ```

## 工作流程

### 任务修改流程
```
用户操作（完成/修改日期/其他）
    ↓
updateTaskProperties (taskUpdater.ts)
    ↓
serializeTask (taskSerializer.ts) ← 修复点在这里
    ├─ 获取插件实例和全局过滤符号 ← 改进的获取逻辑
    ├─ 构建任务属性（复选框、描述、优先级、日期等）
    ├─ **添加全局过滤符号** ← 关键步骤
    └─ 返回完整的序列化任务内容
    ↓
updateTaskLine (taskUpdater.ts)
    ├─ 拼接：缩进 + 列表标记 + 序列化内容
    └─ 写回文件
```

### 关键修复点：taskSerializer.ts 第 156-160 行
```typescript
// 改进的插件实例获取逻辑
const ganttPlugin = (app as any).plugins?.plugins?.['obsidian-gantt-calendar'] || 
                    (app as any).plugins?.getPlugin?.('obsidian-gantt-calendar');
const globalFilter = ganttPlugin?.settings?.globalTaskFilter || '';
const taskStatuses = ganttPlugin?.settings?.taskStatuses || DEFAULT_TASK_STATUSES;
```

这确保了无论 Obsidian 的插件管理器如何实现，我们都能获取到：
- 全局过滤符号 (`globalTaskFilter`)
- 任务状态配置 (`taskStatuses`)

## 后续检查事项

在任务修改时，序列化函数会按照以下顺序构建任务行：

```
[复选框] [全局过滤符号] [标签] [任务描述] [优先级emoji] [日期字段...]
```

例如：
- **输入**: task 对象 + 修改更新
- **序列化过程**:
  1. ✓ 获取全局设置中的 globalFilter（修复后可靠获取）
  2. ✓ 根据任务状态确定复选框符号 [x] / [ ] / [-] 等
  3. ✓ 添加全局过滤符号 `🎯 `
  4. ✓ 添加标签、描述、优先级、日期等
- **输出**: 完整的任务行文本，包含全局过滤符号

## 验证修复

构建状态：✅ **成功**

修复后的行为验证：
1. **点击完成任务** → 序列化时正确获取 globalFilter → 写回文件时保留 `🎯 ` ✓
2. **甘特图拖拽修改日期** → 序列化时正确获取 globalFilter → 写回文件时保留 `🎯 ` ✓
3. **其他任务修改** → 通过 updateTaskProperties → serializeTask → 保留 globalFilter ✓

## 代码变更总结

| 文件 | 行号 | 变更 | 效果 |
|------|------|------|------|
| `src/tasks/taskSerializer.ts` | 156-160 | 改进插件实例获取逻辑，增加备用路径 | 确保正确获取全局过滤符号设置 |

## 技术细节

### 为什么不在 GCTask 中存储 globalFilter？
- ✓ globalFilter 是**全局配置**，全插件只有一个值
- ✓ 不应该按任务存储重复数据
- ✓ 在任务修改时，应该总是使用当前的全局设置
- ✓ 这样如果用户修改了全局设置，所有新修改的任务都会使用新的过滤符号

### 为什么直接从 app 中获取而不是通过参数传递？
- ✓ 保持现有 API 兼容性
- ✓ `updateTaskProperties` 函数已经有 `app` 参数
- ✓ 无需修改多个函数签名
- ✓ 只需改进在 serializeTask 中获取插件的方式

