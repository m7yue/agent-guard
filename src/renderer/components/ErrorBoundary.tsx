import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Alert } from 'antd'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// 渲染异常不应该让整个窗口白屏——至少把错误显示出来
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] 渲染出错', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Alert
          type="error"
          showIcon
          message="界面渲染出错"
          description={this.state.error.message}
          style={{ margin: 24 }}
        />
      )
    }
    return this.props.children
  }
}
