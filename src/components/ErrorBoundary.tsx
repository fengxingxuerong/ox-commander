import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
}

/**
 * Last-resort boundary around the whole app.
 *
 * Without it, any throw during render unmounts the entire tree: the operator
 * gets a blank window with no way back short of restarting the app — and loses
 * whatever the in-memory board state was showing. This keeps the shell alive,
 * names the failure, and offers a reset that does not require a restart.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the reason reachable from DevTools; the UI shows only the message so
    // a stack never ends up in a screenshot the operator shares.
    console.error("[ox-commander] 渲染崩溃", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: undefined });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page" role="alert">
        <header className="page-header">
          <h1>界面出错了</h1>
          <p>
            渲染时抛出了异常，已阻止整个界面白屏。你可以重试渲染；如果反复出现，
            请把下面的信息反馈给开发者。
          </p>
        </header>
        <section className="card">
          <pre className="log-view">{error.message || String(error)}</pre>
          <div className="btn-row">
            <button className="primary" onClick={this.reset}>
              重试渲染
            </button>
            <button onClick={() => window.location.reload()}>重启界面</button>
          </div>
        </section>
      </div>
    );
  }
}
