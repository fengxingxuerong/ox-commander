import { useEffect } from "react";
import { useApp } from "./store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HudNav } from "./components/HudNav";
import { ProjectsPage } from "./pages/ProjectsPage";
import { BoardPage } from "./pages/BoardPage";
import { PrdReviewPage } from "./pages/PrdReviewPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const page = useApp((s) => s.page);
  const handleEvent = useApp((s) => s.handleEvent);
  const refreshProjects = useApp((s) => s.refreshProjects);

  useEffect(() => {
    void refreshProjects();
    return api_unsubscribe(handleEvent);
  }, [handleEvent, refreshProjects]);

  return (
    <div className="app-shell">
      {/* 顶栏在 ErrorBoundary **之外**：页面渲染炸了也还能切到别的模块、
          而不是整块黑屏。崩溃信息由边界自己渲染在内容区里。 */}
      <HudNav />
      <main className="app-main">
        <ErrorBoundary>
          <CurrentPage page={page} />
        </ErrorBoundary>
      </main>
      <div className="app-scanlines" aria-hidden="true" />
    </div>
  );
}

function CurrentPage({ page }: { page: ReturnType<typeof useApp.getState>["page"] }) {
  switch (page) {
    case "board":
      return <BoardPage />;
    case "prd-review":
      return <PrdReviewPage />;
    case "chat":
      return <ChatPage />;
    case "settings":
      return <SettingsPage />;
    case "projects":
      // projects 是**默认页**，所以以前只写在 default 里。写出来不为改行为，
      // 是为了让 `scripts/check-exhaustive-maps.mjs` 能判"每一档都登记过"：
      // 靠 default 兜时，将来新增一个 page 会静默渲染成 ProjectsPage。
      return <ProjectsPage />;
    default:
      // 未知 page 仍然回落到项目页（浏览器开发模式下 store 初值可能来自旧版本持久化）。
      return <ProjectsPage />;
  }
}

function api_unsubscribe(handler: (payload: Record<string, unknown>) => void): () => void {
  try {
    return window.oxCommander.onEvent(handler as (payload: unknown) => void);
  } catch {
    // Browser dev mode without Electron preload.
    return () => undefined;
  }
}
