// 记忆管理：搜索 + 表格 + 编辑弹窗。
//
// 这是用户显式管理记忆的入口；模型没有 delete_memory 工具。
// 有运行中的任务时删除按钮禁用（执行器也会再拦截一次），编辑仍然可用。
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Alert, Button, DatePicker, Drawer, Form, Input, Modal, Popconfirm, Select, Table, Tag, Tooltip } from 'antd'
import type { TableProps } from 'antd'
import type { Dayjs } from 'dayjs'
import type { MemorySummary, MemoryType } from '../../shared/memory'
import { useMemories } from '../hooks/useMemories'

const TYPE_LABELS: Record<MemoryType, string> = {
  user: '用户',
  feedback: '反馈',
  project: '项目',
  reference: '引用',
}

const TYPE_COLORS: Record<MemoryType, string> = {
  user: 'blue',
  feedback: 'gold',
  project: 'green',
  reference: 'purple',
}

const MEMORY_TYPE_OPTIONS = (Object.keys(TYPE_LABELS) as MemoryType[]).map((type) => ({
  value: type,
  label: TYPE_LABELS[type],
}))

const { RangePicker } = DatePicker

interface MemoryPanelProps {
  open: boolean
  /** 任意会话有运行中的任务：删除入口禁用 */
  isAnyRunActive: boolean
  onClose: () => void
  /** 保存/删除成功后刷新审计 */
  onChanged: () => void
}

/** 已提交给服务端的筛选条件；输入框里的是草稿，点“搜索”才生效 */
interface MemoryFilters {
  name?: string
  description?: string
  type?: MemoryType
  updatedAtFrom?: number
  updatedAtTo?: number
}

function toTime(value: number): string {
  return new Date(value).toLocaleString()
}

export function MemoryPanel({
  open,
  isAnyRunActive,
  onClose,
  onChanged,
}: MemoryPanelProps): JSX.Element {
  const [form] = Form.useForm()
  const memoryManager = useMemories({ onChanged })
  const [nameFilter, setNameFilter] = useState('')
  const [descriptionFilter, setDescriptionFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<MemoryType | 'all'>('all')
  const [updatedRange, setUpdatedRange] = useState<[Dayjs, Dayjs] | null>(null)
  const [appliedFilters, setAppliedFilters] = useState<MemoryFilters>({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [sortBy, setSortBy] = useState<'name' | 'updatedAt'>('updatedAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [deletingName, setDeletingName] = useState<string | null>(null)

  // 服务端查询：只用已提交的条件；输入框改动不查，点“搜索”/翻页/排序才查。
  useEffect(() => {
    if (!open) return
    void memoryManager.refresh({
      ...appliedFilters,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      sortBy,
      sortOrder,
    })
  }, [open, appliedFilters, page, pageSize, sortBy, sortOrder, memoryManager.refresh])

  // 删除当前页最后一条后，total 可能仍大于 0，但当前页为空；回退一页。
  useEffect(() => {
    if (open && !memoryManager.isLoading && memoryManager.items.length === 0 && memoryManager.total > 0 && page > 1) {
      setPage((current) => current - 1)
    }
  }, [open, memoryManager.isLoading, memoryManager.items.length, memoryManager.total, page])

  useEffect(() => {
    if (memoryManager.selected) {
      form.setFieldsValue({
        description: memoryManager.selected.description,
        type: memoryManager.selected.type,
        body: memoryManager.selected.body,
      })
    } else {
      form.resetFields()
    }
  }, [form, memoryManager.selected])

  const handleEdit = async (name: string): Promise<void> => {
    await memoryManager.openMemory(name)
  }

  const handleSave = async (): Promise<void> => {
    try {
      const values = (await form.validateFields()) as {
        description: string
        type: MemoryType
        body: string
      }
      const saved = await memoryManager.save(values)
      if (saved) memoryManager.clearSelected()
    } catch {
      // 表单校验失败：Form.Item 已展示错误，不需要额外提示
    }
  }

  const handleDelete = async (item: MemorySummary): Promise<void> => {
    setDeletingName(item.name)
    try {
      await memoryManager.remove(item)
    } finally {
      setDeletingName(null)
    }
  }

  const handleSearch = (): void => {
    setAppliedFilters({
      name: nameFilter.trim() || undefined,
      description: descriptionFilter.trim() || undefined,
      type: typeFilter === 'all' ? undefined : typeFilter,
      updatedAtFrom: updatedRange?.[0].valueOf(),
      updatedAtTo: updatedRange?.[1].valueOf(),
    })
    setPage(1)
  }

  const resetFilters = (): void => {
    setNameFilter('')
    setDescriptionFilter('')
    setTypeFilter('all')
    setUpdatedRange(null)
    setAppliedFilters({})
    setPage(1)
  }

  const columns: TableProps<MemorySummary>['columns'] = [
    {
      title: 'name',
      dataIndex: 'name',
      width: 180,
      sorter: true,
      sortOrder: sortBy === 'name' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (name: string) => <span className="memory-name">{name}</span>,
    },
    {
      title: 'type',
      dataIndex: 'type',
      width: 90,
      render: (type: MemoryType) => <Tag color={TYPE_COLORS[type]}>{TYPE_LABELS[type]}</Tag>,
    },
    {
      title: 'description',
      dataIndex: 'description',
      ellipsis: true,
    },
    {
      title: 'updatedAt',
      dataIndex: 'updatedAt',
      width: 180,
      sorter: true,
      sortOrder: sortBy === 'updatedAt' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (value: number) => toTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_, item) => (
        <div className="memory-actions">
          <Button type="link" size="small" onClick={() => void handleEdit(item.name)}>
            编辑
          </Button>
          <Tooltip title={isAnyRunActive ? '有运行中的任务，停止后再删除' : ''}>
            <span>
              <Popconfirm
                title="删除这条记忆？"
                description="正文和检索索引都会删除；审计只保留 name/type 元数据。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                disabled={isAnyRunActive}
                onConfirm={() => void handleDelete(item)}
              >
                <Button
                  type="link"
                  size="small"
                  danger
                  disabled={isAnyRunActive}
                  loading={deletingName === item.name}
                >
                  删除
                </Button>
              </Popconfirm>
            </span>
          </Tooltip>
        </div>
      ),
    },
  ]

  return (
    <Drawer
      title="记忆管理"
      open={open}
      onClose={onClose}
      width="min(1120px, 96vw)"
      className="memory-drawer"
    >
      {isAnyRunActive ? (
        <Alert
          type="warning"
          showIcon
          message="有正在进行的任务，删除已禁用"
          description="当前 run 可能已经把某条记忆选进上下文；停止运行后再删除，避免“已删除但仍被使用”。"
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {memoryManager.error ? (
        <Alert
          type="error"
          showIcon
          closable
          message={memoryManager.error}
          onClose={memoryManager.clearError}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div className="memory-toolbar">
        <Input
          allowClear
          placeholder="name 包含…"
          value={nameFilter}
          onChange={(event) => setNameFilter(event.target.value)}
          onPressEnter={handleSearch}
          style={{ width: 200 }}
        />
        <Select
          value={typeFilter}
          onChange={setTypeFilter}
          options={[{ value: 'all', label: '全部类型' }, ...MEMORY_TYPE_OPTIONS]}
          style={{ width: 130 }}
        />
        <Input
          allowClear
          placeholder="description 包含…"
          value={descriptionFilter}
          onChange={(event) => setDescriptionFilter(event.target.value)}
          onPressEnter={handleSearch}
          style={{ width: 240 }}
        />
        <RangePicker
          allowClear
          showTime={{ format: 'HH:mm' }}
          format="YYYY-MM-DD HH:mm"
          placeholder={['更新时间起', '更新时间止']}
          value={updatedRange}
          onChange={(values) => {
            setUpdatedRange(values && values[0] && values[1] ? [values[0], values[1]] : null)
          }}
          style={{ width: 320 }}
        />
        <Button type="primary" onClick={handleSearch}>
          搜索
        </Button>
        <Button onClick={resetFilters}>重置</Button>
      </div>

      <Table<MemorySummary>
        rowKey="name"
        columns={columns}
        dataSource={memoryManager.items}
        loading={memoryManager.isLoading}
        locale={{ emptyText: '还没有记忆' }}
        onChange={(pagination, _filters, sorter) => {
          setPage(pagination.current ?? 1)
          setPageSize(pagination.pageSize ?? 10)
          const active = Array.isArray(sorter) ? sorter[0] : sorter
          if (active?.order && (active.field === 'name' || active.field === 'updatedAt')) {
            setSortBy(active.field === 'name' ? 'name' : 'updatedAt')
            setSortOrder(active.order === 'ascend' ? 'asc' : 'desc')
          } else {
            setSortBy('updatedAt')
            setSortOrder('desc')
          }
        }}
        pagination={{
          current: page,
          pageSize,
          total: memoryManager.total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50],
          showTotal: (total) => `共 ${total} 条`,
        }}
        scroll={{ x: 760 }}
      />

      <Modal
        title="编辑记忆"
        open={memoryManager.selected !== null}
        onCancel={() => memoryManager.clearSelected()}
        onOk={() => void handleSave()}
        okText="保存"
        cancelText="取消"
        confirmLoading={memoryManager.isSaving}
        destroyOnHidden
      >
        {memoryManager.error ? (
          <Alert
            type="error"
            showIcon
            closable
            message={memoryManager.error}
            onClose={memoryManager.clearError}
            style={{ marginBottom: 12 }}
          />
        ) : null}
        <Form form={form} layout="vertical">
          <Form.Item label="name">
            <Input value={memoryManager.selected?.name ?? ''} disabled />
          </Form.Item>
          <Form.Item
            label="description"
            name="description"
            rules={[{ required: true, message: 'description 不能为空' }]}
          >
            <Input maxLength={160} showCount />
          </Form.Item>
          <Form.Item label="type" name="type" rules={[{ required: true }]}>
            <Select options={MEMORY_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item
            label="body"
            name="body"
            rules={[{ required: true, message: 'body 不能为空' }]}
          >
            <Input.TextArea rows={8} maxLength={2000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  )
}
