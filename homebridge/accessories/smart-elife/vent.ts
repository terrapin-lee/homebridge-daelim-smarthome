import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {DeviceWithOp} from "./accessories";
import ActiveAccessories, {ActiveAccessoryInterface} from "./active-accessories";

enum RotationSpeed {
    OFF = "off",
    LOW = "low",
    MIDDLE = "middle",
    HIGH = "high",
}

enum Mode {
    AUTO_DRIVING = "auto",
    BYPASS = "bypass",
    MANUAL = "manual",
}

const ROTATION_SPEED_STEP = 100 / 3.0;
const VENT_OPERATION_TIMEOUT_MILLISECONDS = 3_000;

interface VentAccessoryInterface extends ActiveAccessoryInterface {
    rotationSpeed: RotationSpeed
    mode: string
}

interface PendingVentConfirmation {
    operation: Record<string, any>
    complete: (confirmed: boolean) => void
}

export default class VentAccessories extends ActiveAccessories<VentAccessoryInterface> {
    private readonly deviceOperationQueues = new Map<string, Promise<void>>();
    private readonly pendingConfirmations = new Map<string, PendingVentConfirmation>();
    private operationTimeoutMilliseconds = VENT_OPERATION_TIMEOUT_MILLISECONDS;

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.VENT, [api.hap.Service.AirPurifier, api.hap.Service.AirQualitySensor], api.hap.Service.AirPurifier);
    }

    private homebridgeToRotationSpeed(value: number): RotationSpeed {
        if(value <= 0) return RotationSpeed.OFF;
        if(value <= ROTATION_SPEED_STEP) return RotationSpeed.LOW;
        if(value <= ROTATION_SPEED_STEP * 2) return RotationSpeed.MIDDLE;
        return RotationSpeed.HIGH;
    }

    private rotationSpeedToHomebridge(rotationSpeed: RotationSpeed): number {
        switch (rotationSpeed) {
            case RotationSpeed.OFF: return 0;
            case RotationSpeed.LOW: return ROTATION_SPEED_STEP;
            case RotationSpeed.MIDDLE: return ROTATION_SPEED_STEP * 2;
            case RotationSpeed.HIGH: return 100;
            // HomeKit has no unknown-speed value; expose no manual speed until the next
            // valid device update instead of pushing undefined into the characteristic.
            default: return 0;
        }
    }

    private isHomeKitAutomaticMode(mode: string | undefined): boolean {
        return !!mode && mode !== Mode.MANUAL;
    }

    private isHomeKitControllableMode(mode: string | undefined): boolean {
        return mode === Mode.MANUAL || mode === Mode.AUTO_DRIVING;
    }

    private isFanSpeedControllableMode(mode: string | undefined): boolean {
        // The native UI disables wind speed only for automatic driving and bypass.
        // Cleaning, base ventilation, and future externally selected modes retain
        // their independent low/middle/high control when wind_speed is available.
        return !!mode && mode !== Mode.AUTO_DRIVING && mode !== Mode.BYPASS;
    }

    private deviceMode(value: unknown, fallback: string = Mode.AUTO_DRIVING): string {
        // Preserve app-controlled modes that HomeKit cannot represent. Every non-manual
        // mode is exposed as HomeKit AUTO without discarding its native behavior.
        return typeof value === "string" && value.length > 0
            ? value
            : fallback;
    }

    private deviceRotationSpeed(value: unknown): RotationSpeed {
        switch(value) {
            case RotationSpeed.LOW:
            case RotationSpeed.MIDDLE:
            case RotationSpeed.HIGH:
                return value;
            default:
                return RotationSpeed.OFF;
        }
    }

    private updateActivityCharacteristics(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        const service = this.getService(accessory, this.api.hap.Service.AirPurifier);
        service.updateCharacteristic(this.api.hap.Characteristic.Active, context.active
            ? this.api.hap.Characteristic.Active.ACTIVE
            : this.api.hap.Characteristic.Active.INACTIVE);
        service.updateCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, context.active
            ? this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
            : this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE);
    }

    private operationMatchesContext(deviceId: string, operation: Record<string, any>): boolean {
        const accessory = this.findAccessory(deviceId);
        if(!accessory) return false;

        const context = this.getAccessoryInterface(accessory);
        let compared = false;
        if(typeof operation["control"] === "string") {
            compared = true;
            if(context.active !== (operation["control"] === "on")) return false;
        }
        if(typeof operation["mode"] === "string") {
            compared = true;
            if(context.mode !== operation["mode"]) return false;
        }
        if(typeof operation["wind_speed"] === "string") {
            compared = true;
            if(!context.active || !this.isFanSpeedControllableMode(context.mode)
                || context.rotationSpeed !== operation["wind_speed"]) return false;
        }
        return compared;
    }

    private operationMatchesDeviceState(operation: Record<string, any>, state: Record<string, any>): boolean {
        let compared = false;
        if(typeof operation["control"] === "string") {
            compared = true;
            if(state["status"] !== operation["control"]) return false;
        }
        if(typeof operation["mode"] === "string") {
            compared = true;
            if(state["mode"] !== operation["mode"]) return false;
        }
        if(typeof operation["wind_speed"] === "string") {
            compared = true;
            if(state["wind_speed"] !== operation["wind_speed"]) return false;
        }
        return compared;
    }

    private createDeviceConfirmation(deviceId: string, operation: Record<string, any>) {
        let complete: (confirmed: boolean) => void = () => undefined;
        const promise = new Promise<boolean>((resolve) => {
            let completed = false;
            const timer = setTimeout(() => {
                if(completed) return;
                completed = true;
                this.pendingConfirmations.delete(deviceId);
                this.log.warn("Vent operation was not confirmed by a device event: %s", JSON.stringify(operation));
                resolve(false);
            }, this.operationTimeoutMilliseconds);
            timer.unref();

            complete = (confirmed: boolean) => {
                if(completed) return;
                completed = true;
                clearTimeout(timer);
                this.pendingConfirmations.delete(deviceId);
                resolve(confirmed);
            };
        });

        this.pendingConfirmations.set(deviceId, {operation, complete});
        return {promise, cancel: () => complete(false)};
    }

    private confirmDeviceOperation(device: DeviceWithOp) {
        const pending = this.pendingConfirmations.get(device.deviceId);
        if(pending && this.operationMatchesDeviceState(pending.operation, device.op)) {
            pending.complete(true);
        }
    }

    private async sendDeviceStateAndWait(device: DeviceWithOp): Promise<boolean> {
        if(this.operationMatchesContext(device.deviceId, device.op)) return true;

        // Install the waiter before the HTTP request so a fast websocket event cannot
        // arrive between request acceptance and confirmation registration.
        const confirmation = this.createDeviceConfirmation(device.deviceId, device.op);
        try {
            const accepted = await super.setDeviceState(device);
            if(!accepted) {
                confirmation.cancel();
                return false;
            }
            return await confirmation.promise;
        } catch(error) {
            confirmation.cancel();
            throw error;
        }
    }

    private async enqueueDeviceOperation(deviceId: string, operation: () => Promise<boolean>): Promise<boolean> {
        const previous = this.deviceOperationQueues.get(deviceId) || Promise.resolve();
        const queued = previous.then(operation, operation);
        const tail = queued.then(() => undefined, () => undefined);
        this.deviceOperationQueues.set(deviceId, tail);
        try {
            return await queued;
        } finally {
            if(this.deviceOperationQueues.get(deviceId) === tail) {
                this.deviceOperationQueues.delete(deviceId);
            }
        }
    }

    async setDeviceState(device: DeviceWithOp): Promise<boolean> {
        try {
            return await this.enqueueDeviceOperation(device.deviceId, async () => await this.sendDeviceStateAndWait(device));
        } catch(error: any) {
            this.log.warn("Vent control request failed: %s", error?.message || error);
            return false;
        }
    }

    onSetActivityOp(value: boolean, op: Record<string, any>): any {
        if(value)
            op["off_rsv_time"] = "0";
        return op;
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        this.getService(accessory, this.api.hap.Service.AirPurifier)
            .getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(!context.active) {
                    // Smart e-Life disables mode controls while the vent is off. Unlike a
                    // nonzero RotationSpeed, TargetAirPurifierState has a separate HomeKit
                    // Active control, so reject rather than claiming an unapplied mode.
                    callback(new Error("Ventilation mode is unavailable while the vent is inactive."));
                    return;
                }
                const requestedMode = value === this.api.hap.Characteristic.TargetAirPurifierState.MANUAL
                    ? Mode.MANUAL
                    : Mode.AUTO_DRIVING;
                if(requestedMode === context.mode
                    || (requestedMode === Mode.AUTO_DRIVING && this.isHomeKitAutomaticMode(context.mode))) {
                    callback(undefined);
                    return;
                }
                if(!this.isHomeKitControllableMode(context.mode)) {
                    // HomeKit cannot name bypass, cleaning, base ventilation, or future
                    // app-controlled modes. Preserve those modes instead of replacing them
                    // with a superficially equivalent MANUAL/AUTO value.
                    callback(new Error("Ventilation mode is controlled externally by Smart e-Life."));
                    return;
                }
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                const success = await this.setDeviceState({
                    ...device,
                    op: {mode: requestedMode},
                });
                if(!success) {
                    callback(new Error("Failed to set the device state."));
                    return;
                }
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.mode === Mode.MANUAL
                    ? this.api.hap.Characteristic.TargetAirPurifierState.MANUAL
                    : this.api.hap.Characteristic.TargetAirPurifierState.AUTO);
            });
        this.getService(accessory, this.api.hap.Service.AirPurifier)
            .getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.active
                    ? this.api.hap.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
                    : this.api.hap.Characteristic.CurrentAirPurifierState.INACTIVE);
            });
        this.getService(accessory, this.api.hap.Service.AirPurifier)
            .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
            .setProps({
                format: this.api.hap.Formats.FLOAT,
                minValue: 0,
                maxValue: 100,
                minStep: ROTATION_SPEED_STEP,
            })
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                const numeric = value as number;
                const device = this.findDevice(context.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }
                const oldSpeed = context.rotationSpeed;
                const newSpeed = this.homebridgeToRotationSpeed(numeric);
                this.log.debug(`Vent :: SET :: RotationSpeed: ${numeric.toFixed(2)} (HomeKit) -> ${newSpeed.toString()}`);

                // HomeKit represents off as 0%, while Smart e-Life exposes power as a
                // separate control. Handle zero before auto-start so an off request can
                // never turn an inactive vent back on or send the unsupported speed "off".
                if(newSpeed === RotationSpeed.OFF) {
                    if(!context.active) {
                        context.rotationSpeed = RotationSpeed.OFF;
                        callback(undefined);
                        return;
                    }
                    const turnedOff = await this.setDeviceState({
                        ...device, op: { control: "off" },
                    });
                    if(!turnedOff) {
                        callback(new Error("Failed to set the device state."));
                        return;
                    }
                    callback(undefined);
                    return;
                }

                // The native UI disables wind-speed controls in auto and bypass modes.
                // HomeKit cannot dynamically hide RotationSpeed, so reject writes in
                // exactly those modes without changing the external selection.
                if(!this.isFanSpeedControllableMode(context.mode)) {
                    callback(new Error("Fan speed is unavailable in the current ventilation mode."));
                    return;
                }

                if(context.active && oldSpeed === newSpeed) {
                    callback(undefined);
                    return;
                }

                const speedSet = await this.setDeviceFanSpeed(accessory, newSpeed);
                if(!speedSet) {
                    callback(new Error("Failed to set the fan speed."));
                    return;
                }
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.rotationSpeedToHomebridge(context.rotationSpeed));
            });
    }

    async setDeviceFanSpeed(accessory: PlatformAccessory, newSpeed: RotationSpeed) {
        const initialContext = this.getAccessoryInterface(accessory);
        if(!this.isFanSpeedControllableMode(initialContext.mode) || newSpeed === RotationSpeed.OFF) return false;

        const device = this.findDevice(initialContext.deviceId);
        if(!device) {
            return false;
        }
        try {
            return await this.enqueueDeviceOperation(device.deviceId, async () => {
                let context = this.getAccessoryInterface(accessory);
                if(!this.isFanSpeedControllableMode(context.mode)) return false;

                if(!context.active) {
                    this.log.debug(`Vent :: SET :: Automatically turned on Vent.`);
                    const turnedOn = await this.sendDeviceStateAndWait({
                        ...device,
                        op: this.onSetActivityOp(true, {control: "on"}),
                    });
                    if(!turnedOn) return false;

                    context = this.getAccessoryInterface(accessory);
                    if(!context.active || !this.isFanSpeedControllableMode(context.mode)) return false;
                }

                if(context.rotationSpeed === newSpeed) return true;
                return await this.sendDeviceStateAndWait({
                    ...device,
                    op: {wind_speed: newSpeed.toString()},
                });
            });
        } catch(error: any) {
            this.log.warn("Vent fan-speed request failed: %s", error?.message || error);
            return false;
        }
    }

    register() {
        super.register();

        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const cachedAccessory = this.findAccessory(device.deviceId);
                const cachedContext = cachedAccessory
                    ? this.getAccessoryInterface(cachedAccessory)
                    : undefined;
                const active = device.op["status"] === "on"
                    ? true
                    : device.op["status"] === "off"
                        ? false
                        : cachedContext?.active || false;
                const mode = this.deviceMode(device.op["mode"], cachedContext?.mode);
                const rotationSpeed = active && this.isFanSpeedControllableMode(mode)
                    ? this.deviceRotationSpeed(device.op["wind_speed"] || cachedContext?.rotationSpeed)
                    : RotationSpeed.OFF;
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    active,
                    rotationSpeed,
                    mode,
                });
                if(!accessory) {
                    this.confirmDeviceOperation(device);
                    continue;
                }

                const context = this.getAccessoryInterface(accessory);
                const service = accessory.getService(this.api.hap.Service.AirPurifier);
                this.updateActivityCharacteristics(accessory);
                service?.updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState,
                    context.mode === Mode.MANUAL
                        ? this.api.hap.Characteristic.TargetAirPurifierState.MANUAL
                        : this.api.hap.Characteristic.TargetAirPurifierState.AUTO);
                service?.updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.rotationSpeedToHomebridge(rotationSpeed));
                this.confirmDeviceOperation(device);
            }
        });
    }
}
