export interface TurnAttemptState {
  richResponseSent: boolean;
  draftForReview?: string;
}

export function resetAttemptOutputs(state: TurnAttemptState): void {
  state.richResponseSent = false;
  state.draftForReview = undefined;
}
