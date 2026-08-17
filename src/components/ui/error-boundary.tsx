"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";

interface DebugErrorBoundaryProps {
  children: ReactNode;
  /** Label identifying which subtree failed — shown in the console + on screen. */
  label?: string;
}

interface DebugErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

/**
 * Client error boundary that surfaces the FULL error instead of the minified
 * production message. React compresses production errors (e.g. `#185`) to a
 * single opaque line; this boundary logs the real `error.stack` plus the React
 * `componentStack` to the browser console AND renders both on screen, so a
 * failure in the test env is locatable without opening devtools.
 */
export class DebugErrorBoundary extends Component<
  DebugErrorBoundaryProps,
  DebugErrorBoundaryState
> {
  state: DebugErrorBoundaryState = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<DebugErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const { label } = this.props;
    // Full diagnostic trail in the browser console — even minified prod builds
    // carry the real stack here. console.error with the raw objects keeps them
    // expandable in devtools.
    console.error(
      `[ErrorBoundary]${label ? ` ${label}` : ""} failed`,
      error,
      info.componentStack,
    );
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} componentStack={componentStack} />;
  }
}

function ErrorFallback({
  error,
  componentStack,
}: {
  error: Error;
  componentStack: string;
}): ReactNode {
  const t = useTranslations("errorBoundary");
  return (
    <div className="mx-auto my-8 max-w-3xl rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <h2 className="font-semibold text-destructive">{t("title")}</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("consoleHint")}</p>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border/50 bg-background p-3 font-mono text-xs leading-relaxed">
        {error.message}
        {"\n\n"}
        {error.stack}
        {"\n\n--- React component stack ---\n"}
        {componentStack || "(no component stack captured)"}
      </pre>
    </div>
  );
}
