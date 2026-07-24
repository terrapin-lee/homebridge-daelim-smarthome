import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    HAPStatus,
    Logging,
    PlatformAccessory,
} from "homebridge";
import {Device, DeviceType, PushType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import Timeout = NodeJS.Timeout;

interface DoorAccessoryInterface extends AccessoryInterface {
    motionTimer?: Timeout
    motionDetected: boolean
    smartDoorDeviceId?: string
    secured?: boolean
    batteryLevel?: number
}

export const EXTERIOR_FRONT_DOOR_DEVICE: Device = {
    displayName: "외부 세대현관",
    name: "세대현관",
    deviceType: DeviceType.DOOR,
    deviceId: "CMFDOR001",
    disabled: false,
};
export const EXTERIOR_COMMUNAL_DOOR_DEVICE: Device = {
    displayName: "외부 공동현관",
    name: "공동현관",
    deviceType: DeviceType.DOOR,
    deviceId: "CMFDOR002",
    disabled: false,
};
export const DOOR_TIMEOUT_DURATION_SECONDS = 5; // 5 seconds
const LOW_BATTERY_THRESHOLD = 20;

export default class DoorAccessories extends Accessories<DoorAccessoryInterface> {
    private readonly smartDoorDevice?: Device;

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.DOOR, [
            api.hap.Service.MotionSensor,
            api.hap.Service.LockMechanism,
            api.hap.Service.Battery,
        ]);

        const smartDoorDevices = config.devices
            .filter((device) => device.deviceType === DeviceType.SMART_DOOR && !device.disabled);
        this.smartDoorDevice = smartDoorDevices[0];
        if(smartDoorDevices.length > 1) {
            this.log.warn(
                "Multiple smartdoor devices are configured; using %s as the lock state source for %s.",
                this.smartDoorDevice.deviceId,
                EXTERIOR_FRONT_DOOR_DEVICE.deviceId,
            );
        }
    }

    protected async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);
        this.log.warn("Identifying `door` not supported.");
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.motionDetected);
            });

        const context = this.getAccessoryInterface(accessory);
        // Only the household front door mirrors the smart door lock; the communal
        // door has no control channel and stays a motion-only accessory.
        if(!this.smartDoorDevice || context.deviceId !== EXTERIOR_FRONT_DOOR_DEVICE.deviceId) {
            this.removeSmartDoorServices(accessory);
            return;
        }

        context.smartDoorDeviceId = this.smartDoorDevice.deviceId;

        const lock = this.getService(accessory, this.api.hap.Service.LockMechanism);
        lock.setPrimaryService(true);
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
            .on(CharacteristicEventTypes.SET, (_value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                setTimeout(() => {
                    this.getService(accessory, this.api.hap.Service.LockMechanism)
                        .getCharacteristic(this.api.hap.Characteristic.LockTargetState)
                        .updateValue(this.lockTargetState(context));
                }, 0);
                callback(HAPStatus.READ_ONLY_CHARACTERISTIC);
            });

        const battery = this.getService(accessory, this.api.hap.Service.Battery);
        battery.getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.batteryLevel === undefined) {
                    callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    return;
                }
                callback(undefined, context.batteryLevel);
            });
        battery.getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                if(context.batteryLevel === undefined) {
                    callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    return;
                }
                callback(undefined, this.lowBatteryState(context.batteryLevel));
            });
        battery.getCharacteristic(this.api.hap.Characteristic.ChargingState)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(undefined, this.api.hap.Characteristic.ChargingState.NOT_CHARGEABLE);
            });
    }

    private removeSmartDoorServices(accessory: PlatformAccessory) {
        for(const serviceType of [this.api.hap.Service.LockMechanism, this.api.hap.Service.Battery]) {
            const service = accessory.getService(serviceType);
            if(service) accessory.removeService(service);
        }
    }

    private lockCurrentState(context: DoorAccessoryInterface): CharacteristicValue {
        if(context.secured === undefined) {
            return this.api.hap.Characteristic.LockCurrentState.UNKNOWN;
        }
        return context.secured
            ? this.api.hap.Characteristic.LockCurrentState.SECURED
            : this.api.hap.Characteristic.LockCurrentState.UNSECURED;
    }

    private lockTargetState(context: DoorAccessoryInterface): CharacteristicValue {
        return context.secured === false
            ? this.api.hap.Characteristic.LockTargetState.UNSECURED
            : this.api.hap.Characteristic.LockTargetState.SECURED;
    }

    private lowBatteryState(batteryLevel: number): CharacteristicValue {
        return batteryLevel <= LOW_BATTERY_THRESHOLD
            ? this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    private parseBatteryLevel(raw: unknown): number | undefined {
        if(raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
            return undefined;
        }
        const level = Number(raw);
        if(!Number.isFinite(level)) {
            return undefined;
        }
        return Math.max(0, Math.min(100, Math.round(level)));
    }

    private ensureDoorAccessory(doorDevice: Device): PlatformAccessory | undefined {
        const device = this.findDevice(doorDevice.deviceId);
        if(!device) return undefined;

        const existing = this.findAccessory(device.deviceId);
        const context = existing
            ? this.getAccessoryInterface(existing)
            : undefined;
        const isFrontDoor = doorDevice.deviceId === EXTERIOR_FRONT_DOOR_DEVICE.deviceId;
        return this.addOrGetAccessory({
            deviceId: device.deviceId,
            deviceType: device.deviceType,
            displayName: device.displayName,
            init: true,
            motionTimer: context?.motionTimer,
            motionDetected: context?.motionDetected ?? false,
            smartDoorDeviceId: isFrontDoor ? this.smartDoorDevice?.deviceId : undefined,
            secured: isFrontDoor ? context?.secured : undefined,
            batteryLevel: isFrontDoor ? context?.batteryLevel : undefined,
        });
    }

    private updateSmartDoorState(accessory: PlatformAccessory, operation: any) {
        const context = this.getAccessoryInterface(accessory);
        const status = operation?.["status"];
        if(status === "open") {
            context.secured = false;
        } else if(status === "close") {
            context.secured = true;
        } else {
            this.log.debug("Ignoring unknown smartdoor status: %s", String(status));
        }

        const lock = accessory.getService(this.api.hap.Service.LockMechanism);
        lock?.getCharacteristic(this.api.hap.Characteristic.LockCurrentState)
            .updateValue(this.lockCurrentState(context));
        if(context.secured !== undefined) {
            lock?.getCharacteristic(this.api.hap.Characteristic.LockTargetState)
                .updateValue(this.lockTargetState(context));
        }

        const parsedBatteryLevel = this.parseBatteryLevel(operation?.["battery"]);
        if(parsedBatteryLevel === undefined) return;

        context.batteryLevel = parsedBatteryLevel;
        const battery = accessory.getService(this.api.hap.Service.Battery);
        battery?.getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
            .updateValue(context.batteryLevel);
        battery?.getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
            .updateValue(this.lowBatteryState(context.batteryLevel));
    }

    registerPushListener(pushType: PushType, doorDevice: Device) {
        this.addPushListener(pushType, () => {
            const device = this.findDevice(doorDevice.deviceId);
            if(!device) {
                this.log.warn("Unknown device: %s", doorDevice.deviceId);
                return;
            }
            const accessory = this.ensureDoorAccessory(doorDevice);
            if(!accessory) {
                this.log.warn("Unknown accessory: %s", device.deviceId);
                return;
            }

            const context = this.getAccessoryInterface(accessory);
            if(context.motionTimer) {
                clearTimeout(context.motionTimer);
            }

            context.motionDetected = true;
            context.motionTimer = setTimeout(() => {
                const context = this.getAccessoryInterface(accessory);
                if(context.motionTimer) {
                    clearTimeout(context.motionTimer);
                }
                context.motionTimer = undefined;
                context.motionDetected = false;

                accessory.getService(this.api.hap.Service.MotionSensor)
                    ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
            }, (device.duration?.door || DOOR_TIMEOUT_DURATION_SECONDS) * 1000);

            accessory.getService(this.api.hap.Service.MotionSensor)
                ?.setCharacteristic(this.api.hap.Characteristic.MotionDetected, context.motionDetected);
        });
    }

    register() {
        super.register();
        this.registerPushListener(PushType.FRONT_DOOR, EXTERIOR_FRONT_DOOR_DEVICE);
        this.registerPushListener(PushType.COMMUNAL_DOOR, EXTERIOR_COMMUNAL_DOOR_DEVICE);

        if(this.smartDoorDevice) {
            this.addDeviceListener((devices) => {
                const smartDoor = devices
                    .find((device) => device.deviceId === this.smartDoorDevice?.deviceId);
                if(!smartDoor) return;

                const accessory = this.ensureDoorAccessory(EXTERIOR_FRONT_DOOR_DEVICE);
                if(!accessory) return;
                this.updateSmartDoorState(accessory, smartDoor.op);
            }, DeviceType.SMART_DOOR);
        }

        setTimeout(() => {
            this.ensureDoorAccessory(EXTERIOR_FRONT_DOOR_DEVICE);
            this.ensureDoorAccessory(EXTERIOR_COMMUNAL_DOOR_DEVICE);
        }, 1000);
    }
}
