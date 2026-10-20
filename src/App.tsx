import { useEffect } from "react";
import { useApp } from "./store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HudNav } from "./components/HudNav";
import { ThreadRail } from "./components/ThreadRail";
import { ReviewRail } from "./components/ReviewRail";
import { ProjectsPage } from "./pages/ProjectsPage";
import { BoardPage } from "./pages/BoardPage";
import { PrdReviewPage } from "./pages/PrdReviewPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const page = useApp((s) => s.page);
  const handleEvent = useApp((s) => s.handleEvent);
  const refreshProjects = useApp((s) => s.refreshProjects);
  const reviewOpen = useApp((s) => s.reviewOpen);
  const setReviewOpen = useApp((s) => s.setReviewOpen);

  useEffect(() => {
    void refreshProjects();
    return api_unsubscribe(handleEvent);
  }, [handleEvent, refreshProjects]);

  // 会话页走**三栏工作台**（M1/M2，对标 Codex）：左栏项目与线程树、中栏执行流、
  // 右栏改动审查。其余四页仍单栏 —— 它们的正文宽度就是它们的内容宽度，
  // 硬套三栏只会给看板与设置页各添两条空边。
  const shell = page === "chat" ? "app-shell app-shell-three" : "app-shell";

  return (
    <div className={shell}>
      {/* 顶栏在 ErrorBoundary **之外**：页面渲染炸了也还能切到别的模块、
          而不是整块黑屏。崩溃信息由边界自己渲染在内容区里。 */}
      <HudNav />
      <div className="app-body">
        {page === "chat" ? <ThreadRail /> : null}
        <main className="app-main">
          <ErrorBoundary>
            <CurrentPage page={page} />
          </ErrorBoundary>
        </main>
        {page === "chat" && reviewOpen ? <ReviewRail onClose={() => setReviewOpen(false)} /> : null}
      </div>
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
