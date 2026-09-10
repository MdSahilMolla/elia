import { Component, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../theme.ts'

interface Props {
  children: ReactNode
  /** Where the boundary sits, for the fallback message ("transcript", "input", …). */
  area: string
  /** Notified once when a child throws — lets the app log the crash to the transcript. */
  onError?: (error: Error, area: string) => void
}

interface State {
  error: Error | null
}

/**
 * Without this, a throw in ANY render path — a bad markdown parse, a highlighter
 * edge case, a nil deref in a tool card — takes down the whole Ink tree and drops
 * the user back to a bare shell mid-session (Devin's audit, item 1). The boundary
 * keeps the rest of the frame alive and shows what broke, so the REPL stays
 * usable and the error is visible instead of fatal.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error, this.props.area)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.failure}>
            ┃ the {this.props.area} hit a render error and was skipped
          </Text>
          <Text color={palette.muted}>┃ {this.state.error.message}</Text>
        </Box>
      )
    }
    return this.props.children
  }
}
