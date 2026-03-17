import { useEffect } from "react";
import { Dashboard } from "./components/Dashboard";
import { useDesktopBootstrap } from "./lib/commands/hooks";
import { useAppStore } from "./state";

export function App() {
  const { data, error, isLoading } = useDesktopBootstrap();
  const setBootstrap = useAppStore((state) => state.setBootstrap);

  useEffect(() => {
    if (data) {
      setBootstrap(data);
    }
  }, [data, setBootstrap]);

  if (isLoading) {
    return <main className="screen-state">正在初始化桌面壳、切块引擎与阅读器...</main>;
  }

  if (error) {
    return <main className="screen-state">启动失败：{error.message}</main>;
  }

  if (!data) {
    return <main className="screen-state">未收到应用初始化数据。</main>;
  }

  return <Dashboard bootstrap={data} />;
}
