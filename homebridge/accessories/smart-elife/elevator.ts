import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {Device, DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Timeout = NodeJS.Timeout;

interface ElevatorAccessoryInterface extends AccessoryInterface {
    switchTimer?: Timeout
    switchLocked: boolean
    // Set by `rerection: "progressing"`, cleared on arrival. Only while this holds does the
    // switch refuse to be turned off - the car really is on its way and cannot be recalled.
    // Without confirmation (socket down, call silently dropped) the switch stays dismissable.
    callProgressing: boolean

    motionTimer?: Timeout
    motionDetected: boolean
}

export const EXTERIOR_ELEVATOR_DEVICE: Device = {
    displayName: "외부 엘리베이터",
    name: "엘리베이터",
    deviceType: DeviceType.ELEVATOR,
    deviceId: "CMF990100",
    disabled: false,
};
const ELEVATOR_MOTION_DURATION_TIMEOUT_SECONDS = 5; // 5 seconds
const ELEVATOR_CALL_FALLBACK_TIMEOUT_SECONDS = 120; // 2 minutes

export default class ElevatorAccessories extends Accessories<ElevatorAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.ELEVATOR, [api.hap.Service.Switch, api.hap.Service.MotionSensor]);
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.getService(accessory, this.api.hap.Service.Switch)
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const called = value as boolean;
                if(!called) {
                    if(context.callProgressing) {
                        // The car is confirmed on its way and there is no way to recall it,
                        // so snap the switch back rather than pretend it was cancelled.
                        // Must be `updateValue`, not `setCharacteristic` - the latter re-enters
                        // this very handler, and when `switchLocked` is already false it
                        // re-arms itself every tick, spinning forever.
                        setTimeout(() => {
                            this.getService(accessory, this.api.hap.Service.Switch)
                                .getCharacteristic(this.api.hap.Characteristic.On)
                                .updateValue(context.switchLocked);
                        }, 0);
                        callback(undefined);
                        return;
                    }
                    // No `progressing` seen, so nothing is known to be moving - let it be
                    // dismissed instead of leaving a switch nobody can turn off until the
                    // fallback expires.
                    if(context.switchTimer) clearTimeout(context.switchTimer);
                    context.switchTimer = undefined;
                    context.switchLocked = false;
                    callback(undefined);
                    return;
                }
                const device = this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                if(called) {
                    // Claim the lock before the round trip, not after it. The call takes
                    // seconds (2.2-5.2s measured) and the arrival frame can land inside that
                    // window - in one call it was 3ms from the response, and a car already
                    // waiting on this floor reports arrival almost immediately. Claiming it
                    // up front also doubles as the sentinel below, because the arrival
                    // handler is the only other writer and it always clears the flag.
                    context.switchLocked = true;

                    let success: boolean;
                    try {
                        success = await this.client.sendElevatorCallQuery();
                    } catch(error) {
                        // The lock is claimed before the round trip, so a throw here would
                        // strand it: no fallback timer is armed yet and `callback` never runs,
                        // leaving the switch locked on with nothing able to release it.
                        context.switchLocked = false;
                        this.log.error("Could not call the elevator: %s", (error as Error)?.message || error);
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                    if(!success) {
                        context.switchLocked = false;
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                    if(!context.switchLocked) {
                        // Arrival landed while we were awaiting. It already released the
                        // switch, so do not arm the fallback timer - but HAP commits the
                        // requested `true` on a successful set, so push the release again.
                        callback(undefined);
                        setTimeout(() => {
                            this.getService(accessory, this.api.hap.Service.Switch)
                                .getCharacteristic(this.api.hap.Characteristic.On)
                                .updateValue(false);
                        }, 0);
                        return;
                    }
                    if(context.switchTimer) clearTimeout(context.switchTimer);

                    context.switchTimer = setTimeout(() => {
                        if(context.switchTimer) clearTimeout(context.switchTimer);

                        context.switchTimer = undefined;
                        context.switchLocked = false;
                        context.callProgressing = false;
                        this.getService(accessory, this.api.hap.Service.Switch)
                            .getCharacteristic(this.api.hap.Characteristic.On)
                            .updateValue(false);
                        // Safety net only - `unprogressing` releases the switch on arrival.
                        // Kept long so a slow car is not cut off; it exists for the case where
                        // the arrival frame never lands (socket reconnect, silently dropped call).
                    }, (device.duration?.elevator || ELEVATOR_CALL_FALLBACK_TIMEOUT_SECONDS) * 1000);
                }
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.switchLocked);
            });

        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.motionDetected);
            });
    }

    register() {
        super.register();

        this.addListener((data) => {
            if(!data) return;
            const rerection = data["rerection"];

            const device = this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId);
            if(!device) return;

            const accessory = this.findAccessory(device.deviceId);
            if(!accessory) return;

            if(rerection === "progressing") {
                // The server acknowledged the call and the car is moving. Arrives ~60ms after
                // the request, well before the HTTP response.
                this.getAccessoryInterface(accessory).callProgressing = true;
                return;
            }
            // Arrival signals. `unprogressing` (from `elevator_call_request`) is the definitive
            // one; `down`/`up` (from `elevate_call`, the arriving car's direction) land alongside
            // it and are treated as the same arrival. Both are routed here now - see the elevator
            // branch in `smart-elife-client.ts`. The duplicate handling below absorbs the extra frame.
            if(!["unprogressing", "down", "up"].includes(rerection)) return;

            const context = this.getAccessoryInterface(accessory);
            context.callProgressing = false;
            if(context.switchTimer)
                clearTimeout(context.switchTimer);
            context.switchLocked = false;
            context.switchTimer = undefined;

            // The arrival notification is surfaced to HomeKit as motion, so the call switch
            // is released on the same signal. Pushing `On` here is mandatory: the timer that
            // would otherwise release it has just been cleared, so without this the switch
            // stays lit in HomeKit until the user toggles it by hand.
            this.getService(accessory, this.api.hap.Service.Switch)
                .getCharacteristic(this.api.hap.Characteristic.On)
                .updateValue(false);

            // `elevator_call_request` arrives repeated within the same tick; without clearing
            // first, each duplicate leaks a timer that would cut the motion window short.
            if(context.motionTimer)
                clearTimeout(context.motionTimer);
            context.motionDetected = true;
            context.motionTimer = setTimeout(() => {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer)
                    clearTimeout(context.motionTimer);
                context.motionTimer = undefined;
                context.motionDetected = false;

                accessory.getService(this.api.hap.Service.MotionSensor)
                    ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
            }, ELEVATOR_MOTION_DURATION_TIMEOUT_SECONDS * 1000);

            accessory.getService(this.api.hap.Service.MotionSensor)
                ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
        });

        setTimeout(async () => {
            if(!this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId)) {
                return;
            }
            const device = EXTERIOR_ELEVATOR_DEVICE;
            this.addOrGetAccessory({
                deviceId: device.deviceId,
                deviceType: device.deviceType,
                displayName: device.displayName,
                init: true,
                switchTimer: undefined,
                switchLocked: false,
                callProgressing: false,
                motionTimer: undefined,
                motionDetected: false,
            });
        }, 1000);
    }
}
