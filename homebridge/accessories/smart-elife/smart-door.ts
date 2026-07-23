import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback, CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";

interface SmartDoorAccessoryInterface extends AccessoryInterface {
    secured: boolean
    batteryLevel: number
}

// The wallpad reports the smart door lock (도어락) as `type: "smartdoor"` with
// `status: "close" | "open"` and a string `battery` level. It is surfaced as a
// read-only LockMechanism plus a Battery service.
const LOW_BATTERY_THRESHOLD = 20;

export default class SmartDoorAccessories extends Accessories<SmartDoorAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.SMART_DOOR, [
            api.hap.Service.LockMechanism,
            api.hap.Service.Battery,
        ]);
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        const lock = this.getService(accessory, this.api.hap.Service.LockMechanism);
        lock.getCharacteristic(this.api.hap.Characteristic.LockCurrentState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.lockCurrentState(context));
            });
        lock.getCharacteristic(this.api.hap.Characteristic.LockTargetState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.lockTargetState(context));
            })
            .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // Read-only: the wallpad exposes the lock's state, but the plugin has no
                // verified remote lock/unlock command and remotely unlocking a front door is
                // security-sensitive. Snap the target back to the real state instead of
                // pretending the change took effect. `updateValue` (not `setCharacteristic`)
                // avoids re-entering this SET handler.
                const context = this.getAccessoryInterface(accessory);
                callback(undefined);
                setTimeout(() => {
                    this.getService(accessory, this.api.hap.Service.LockMechanism)
                        .getCharacteristic(this.api.hap.Characteristic.LockTargetState)
                        .updateValue(this.lockTargetState(context));
                }, 0);
            });

        const battery = this.getService(accessory, this.api.hap.Service.Battery);
        battery.getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.batteryLevel);
            });
        battery.getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.lowBatteryState(context));
            });
        battery.getCharacteristic(this.api.hap.Characteristic.ChargingState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE);
            });
    }

    private lockCurrentState(context: SmartDoorAccessoryInterface): CharacteristicValue {
        return context.secured
            ? this.api.hap.Characteristic.LockCurrentState.SECURED
            : this.api.hap.Characteristic.LockCurrentState.UNSECURED;
    }

    private lockTargetState(context: SmartDoorAccessoryInterface): CharacteristicValue {
        return context.secured
            ? this.api.hap.Characteristic.LockTargetState.SECURED
            : this.api.hap.Characteristic.LockTargetState.UNSECURED;
    }

    private lowBatteryState(context: SmartDoorAccessoryInterface): CharacteristicValue {
        return context.batteryLevel <= LOW_BATTERY_THRESHOLD
            ? this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    private parseBatteryLevel(raw: any): number {
        const level = Number(raw);
        if(!Number.isFinite(level)) {
            return 100;
        }
        return Math.max(0, Math.min(100, level));
    }

    register() {
        super.register();
        this.addDeviceListener((devices) => {
            for(const device of devices) {
                const secured = device.op["status"] === "close";
                const batteryLevel = this.parseBatteryLevel(device.op["battery"]);
                const accessory = this.addOrGetAccessory({
                    deviceId: device.deviceId,
                    deviceType: device.deviceType,
                    displayName: device.displayName,
                    init: true,
                    secured,
                    batteryLevel,
                });
                if(!accessory) continue;

                const context = this.getAccessoryInterface(accessory);
                const lock = accessory.getService(this.api.hap.Service.LockMechanism);
                // Push current AND target so the Home tile resolves out of the intermediate
                // "Locking…/Unlocking…" state promptly when the lock changes at the wallpad.
                // updateValue (not setCharacteristic) so pushing state never re-enters the SET
                // handler.
                lock?.getCharacteristic(this.api.hap.Characteristic.LockCurrentState).updateValue(this.lockCurrentState(context));
                lock?.getCharacteristic(this.api.hap.Characteristic.LockTargetState).updateValue(this.lockTargetState(context));

                const battery = accessory.getService(this.api.hap.Service.Battery);
                battery?.getCharacteristic(this.api.hap.Characteristic.BatteryLevel).updateValue(context.batteryLevel);
                battery?.getCharacteristic(this.api.hap.Characteristic.StatusLowBattery).updateValue(this.lowBatteryState(context));
            }
        });
    }
}
