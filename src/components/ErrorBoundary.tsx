import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.fallbackLabel ?? 'Component', 'crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-3 p-8">
          <p className="text-red-400 font-semibold text-lg">
            {this.props.fallbackLabel ?? 'This component'} crashed. See console for error details.
          </p>
          <p className="text-gray-600 text-sm font-mono">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm hover:bg-gray-700"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
