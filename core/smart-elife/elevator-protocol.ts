import type {WebSocketCredentials} from "./parsers/ws-creds-parsers";

export const ELEVATOR_CALL_REQUEST_ACTION = "elevator_call_request";
export const ELEVATOR_ARRIVAL_ACTION = "elevate_call";

export enum ElevatorCallState {
    UNKNOWN = "unknown",
    IDLE = "idle",
    REQUESTING = "requesting",
    PROGRESSING = "progressing",
}

export interface ElevatorCallTransition {
    state: ElevatorCallState
    recognized: boolean
    arrival: boolean
}

export interface ElevatorCallAttempt {
    state: ElevatorCallState
    accepted: boolean
}

export function normalizeElevatorCallState(state: unknown): ElevatorCallState {
    return Object.values(ElevatorCallState).includes(state as ElevatorCallState)
        ? state as ElevatorCallState
        : ElevatorCallState.UNKNOWN;
}

export function isElevatorCallActive(state: ElevatorCallState): boolean {
    return state === ElevatorCallState.REQUESTING || state === ElevatorCallState.PROGRESSING;
}

export function beginElevatorCall(state: ElevatorCallState): ElevatorCallAttempt {
    if(state !== ElevatorCallState.IDLE) {
        return { state, accepted: false };
    }
    return { state: ElevatorCallState.REQUESTING, accepted: true };
}

export function completeElevatorCallRequest(state: ElevatorCallState): ElevatorCallState {
    // The HTTP response only confirms that the command was accepted. Like the original UI,
    // keep the control disabled only when the independent WebSocket status says progressing.
    return state === ElevatorCallState.REQUESTING ? ElevatorCallState.IDLE : state;
}

export function reduceElevatorServerEvent(
    state: ElevatorCallState,
    action: string | undefined,
    rerection: unknown,
): ElevatorCallTransition {
    if(action === ELEVATOR_CALL_REQUEST_ACTION) {
        if(rerection === "progressing") {
            return { state: ElevatorCallState.PROGRESSING, recognized: true, arrival: false };
        }
        if(rerection === "unprogressing") {
            return { state: ElevatorCallState.IDLE, recognized: true, arrival: false };
        }
    }

    if(action === ELEVATOR_ARRIVAL_ACTION && (rerection === "up" || rerection === "down")) {
        return { state: ElevatorCallState.IDLE, recognized: true, arrival: true };
    }

    return { state, recognized: false, arrival: false };
}

export function createElevatorStatusRequest(credentials: WebSocketCredentials) {
    return {
        roomKey: credentials.roomKey,
        userKey: credentials.userKey,
        accessToken: credentials.accessToken,
        socketType: "elevcall",
        data: [],
    };
}
