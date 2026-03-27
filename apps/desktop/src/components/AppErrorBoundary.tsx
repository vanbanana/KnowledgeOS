import React from "react";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      message: ""
    };
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "未知前端错误"
    };
  }

  componentDidCatch(error: Error) {
    console.error("应用渲染异常：", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="screen-state">
          前端渲染失败：{this.state.message}
        </main>
      );
    }

    return this.props.children;
  }
}
