import { Button } from '@benord-labs/frink-primitives';
import { AlertCircle } from 'lucide-react';
import { Component, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
  viewerType?: string;
  onReset?: () => void;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export class ViewerErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // biome-ignore lint/suspicious/noConsole: Error boundaries should log crash context for debugging.
    console.error(
      `[ViewerErrorBoundary] ${this.props.viewerType || 'viewer'} crashed:`,
      error,
      errorInfo,
    );
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
          <AlertCircle className="h-10 w-10 text-muted-foreground" />
          <p className="font-medium text-foreground">
            Failed to render {this.props.viewerType || 'file'}
          </p>
          <p className="text-sm text-muted-foreground max-w-[300px]">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <Button variant="secondary" size="sm" onClick={this.handleReset}>
            Try again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
