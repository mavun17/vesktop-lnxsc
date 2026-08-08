/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@vencord/types/utils";
import { currentSettings } from "renderer/components/ScreenSharePicker";
import { State } from "renderer/settings";
import { isLinux } from "renderer/utils";

const logger = new Logger("VesktopStreamFixes");

if (isLinux) {
    const original = navigator.mediaDevices.getDisplayMedia;

    async function getVirtmic() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioDevice = devices.find(({ label }) => label === "vencord-screen-share");
            return audioDevice?.deviceId;
        } catch (error) {
            return null;
        }
    }

    navigator.mediaDevices.getDisplayMedia = async function (opts) {
        // 1. Get the target resolution/framerate FIRST
        const frameRate = Number(State.store.screenshareQuality?.frameRate ?? 60);
        const height = Number(State.store.screenshareQuality?.resolution ?? 1080);
        const width = Math.round(height * (16 / 9));

        // 2. FORCE OPTS BEFORE CAPTURE
        // This forces Discord's internal UI badge to read the correct resolution instantly
        if (opts && !opts.video) opts.video = true;
        if (typeof opts?.video !== "object" && opts) opts.video = {};
        if (opts && opts.video && typeof opts.video === "object") {
            opts.video = {
                ...opts.video,
                width: { min: width, ideal: width, max: width },
                height: { min: height, ideal: height, max: height },
                frameRate: { min: frameRate, ideal: frameRate, max: frameRate }
            };
        }

        // 3. Now capture the stream with the forced opts
        const stream = await original.call(this, opts);
        const id = await getVirtmic();

        const track = stream.getVideoTracks()[0];
        track.contentHint = String(currentSettings?.contentHint);

        // 4. Lock the constraints again after capture (just to be safe)
        const constraints = {
            ...track.getConstraints(),
            frameRate: { min: frameRate, ideal: frameRate, max: frameRate },
            width: { min: width, ideal: width, max: width },
            height: { min: height, ideal: height, max: height },
            advanced: [{ width: width, height: height }],
            resizeMode: "none"
        };

        track
            .applyConstraints(constraints)
            .then(() => {
                logger.info("Applied LOCKED constraints successfully. New constraints: ", track.getConstraints());
            })
            .catch(e => logger.error("Failed to apply constraints.", e));

        if (id) {
            const audio = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: {
                        exact: id
                    },
                    autoGainControl: false,
                    echoCancellation: false,
                    noiseSuppression: false,
                    channelCount: 2,
                    sampleRate: 48000,
                    sampleSize: 16
                }
            });

            stream.getAudioTracks().forEach(t => stream.removeTrack(t));
            stream.addTrack(audio.getAudioTracks()[0]);
        }

        return stream;
    };

    // --- WEBRTC BITRATE & DOWNSCALE FORCE PATCH v2 ---
    const originalAddTrack = RTCPeerConnection.prototype.addTrack;
    RTCPeerConnection.prototype.addTrack = function (track: MediaStreamTrack, ...streams: MediaStream[]) {
        const sender = originalAddTrack.call(this, track, ...streams);
        if (track.kind === "video") {
            // SAVE THE SENDER TO THE TRACK SO WE CAN ACCESS IT LATER
            (track as any).__vencordSender = sender;

            const params = sender.getParameters();
            if (!params.encodings) params.encodings = [{}];

            // Lock initial parameters
            params.encodings[0].scaleResolutionDownBy = 1;
            params.encodings[0].maxBitrate = 8000000;

            sender.setParameters(params).catch(e => logger.error("Failed to set initial RTC params:", e));
        }
        return sender;
    };

    // Intercept setParameters to block Discord's UnifiedConnection from downscaling later
    const originalSetParameters = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = async function (params: RTCRtpSendParameters) {
        if (this.track && this.track.kind === "video") {
            // Force scaleResolutionDownBy to 1 (no downscaling)
            if (params.encodings && params.encodings[0]) {
                if (params.encodings[0].scaleResolutionDownBy && params.encodings[0].scaleResolutionDownBy > 1) {
                    logger.warn("Blocked Discord dynamic downscale. Was:", params.encodings[0].scaleResolutionDownBy);
                    params.encodings[0].scaleResolutionDownBy = 1;
                }
                // Prevent bitrate from dropping too low (keep minimum at 4Mbps)
                if (params.encodings[0].maxBitrate && params.encodings[0].maxBitrate < 4000000) {
                    logger.warn("Blocked Discord dynamic bitrate drop. Was:", params.encodings[0].maxBitrate);
                    params.encodings[0].maxBitrate = 4000000;
                }
            }
        }
        return originalSetParameters.call(this, params);
    };

    logger.info("WebRTC Anti-Downscale & Bitrate Force patch v2 injected.");
}
