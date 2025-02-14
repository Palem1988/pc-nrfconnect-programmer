/* Copyright (c) 2015 - 2019, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Use in source and binary forms, redistribution in binary form only, with
 * or without modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions in binary form, except as embedded into a Nordic
 *    Semiconductor ASA integrated circuit in a product or a software update for
 *    such product, must reproduce the above copyright notice, this list of
 *    conditions and the following disclaimer in the documentation and/or other
 *    materials provided with the distribution.
 *
 * 2. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * 3. This software, with or without modification, must only be used with a Nordic
 *    Semiconductor ASA integrated circuit.
 *
 * 4. Any software provided in binary form under this license must not be reverse
 *    engineered, decompiled, modified and/or disassembled.
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 * TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/* eslint-disable import/no-cycle */

import { readFile, stat, statSync } from 'fs';
import { basename } from 'path';

import electron from 'electron';
import Store from 'electron-store';
import { List, Set } from 'immutable';
import MemoryMap from 'nrf-intel-hex';
import { logger } from 'nrfconnect/core';

import { hexpad8 } from '../util/hexpad';
import {
    Region,
    RegionColor,
    RegionName,
    getFileRegions,
} from '../util/regions';
import * as targetActions from './targetActions';
import { addFileWarning, fileWarningRemoveAction } from './warningActions';

const persistentStore = new Store({ name: 'nrf-programmer' });

export const ERROR_DIALOG_SHOW = 'ERROR_DIALOG_SHOW';
export const FILE_PARSE = 'FILE_PARSE';
export const FILE_REGION_NAMES_KNOWN = 'FILE_REGION_NAMES_KNOWN';
export const FILE_REGIONS_KNOWN = 'FILE_REGIONS_KNOWN';
export const FILE_REMOVE = 'FILE_REMOVE';
export const FILES_EMPTY = 'FILES_EMPTY';
export const MCUBOOT_FILE_KNOWN = 'MCUBOOT_FILE_KNOWN';
export const MRU_FILES_LOAD_SUCCESS = 'MRU_FILES_LOAD_SUCCESS';

const MCUBOOT_FW_START_ADDRESS = 0xC000;

export function errorDialogShowAction(error) {
    return {
        type: ERROR_DIALOG_SHOW,
        message: error.message || error,
    };
}

export function fileParseAction(loaded, memMaps) {
    return {
        type: FILE_PARSE,
        loaded,
        memMaps,
    };
}

export function fileRegionsKnownAction(regions) {
    return {
        type: FILE_REGIONS_KNOWN,
        regions,
    };
}

export function fileRegionNamesKnownAction(detectedRegionNames) {
    return {
        type: FILE_REGION_NAMES_KNOWN,
        detectedRegionNames,
    };
}

export function filesEmptyAction() {
    return {
        type: FILES_EMPTY,
    };
}

export function mruFilesLoadSuccessAction(files) {
    return {
        type: MRU_FILES_LOAD_SUCCESS,
        files,
    };
}

export function mcubootFileKnownAction(filePath) {
    return {
        type: MCUBOOT_FILE_KNOWN,
        filePath,
    };
}

function updateDetectedRegionNames() {
    return (dispatch, getState) => {
        const fileRegions = getState().app.file.regions;
        const regionChecklist = new List([
            RegionName.APPLICATION,
            RegionName.SOFTDEVICE,
            RegionName.BOOTLOADER,
        ]);
        let detectedRegionNames = new Set();
        fileRegions.forEach(r => {
            if (r.name && regionChecklist.includes(r.name)) {
                detectedRegionNames = detectedRegionNames.add(r.name);
            }
        });
        dispatch(fileRegionNamesKnownAction(detectedRegionNames));
    };
}

// There is an Application on top of SoftDevice in the HEX file,
// but there is no SoftDevice in the HEX file,
// In this case, if there is a SoftDevice being found in target device,
// then the Application region should be displayed.
// If there is no SoftDevice in both HEX file and target device,
// then the user should give input instead.
// (Or fix getting softdevice id from bootloader)
export function updateFileAppRegions() {
    return (dispatch, getState) => {
        let fileRegions = getState().app.file.regions;
        const targetRegions = getState().app.target.regions;
        const targetBootloaderRegion = targetRegions.find(r => r.name === RegionName.BOOTLOADER);

        let appStartAddress;
        let appEndAddress;
        fileRegions.forEach(r => {
            // Detect the start address of all applications
            if (r.name === RegionName.APPLICATION
                && (!appStartAddress || appStartAddress > r.startAddress)) {
                appStartAddress = r.startAddress;
            }
            // Detect the end address of all applications
            if (targetBootloaderRegion
                && r.name === RegionName.APPLICATION
                && r.startAddress < targetBootloaderRegion.startAddress
                && (!appEndAddress || appEndAddress < r.startAddress)) {
                appEndAddress = r.startAddress + r.regionSize;
            }
        });

        // Merge Application regions if more than one application are detected.
        if (targetBootloaderRegion
            && appStartAddress !== undefined
            && appEndAddress !== undefined) {
            fileRegions.forEach(r => {
                if (r.name === RegionName.APPLICATION
                    && r.startAddress < targetBootloaderRegion.startAddress) {
                    fileRegions = fileRegions.remove(fileRegions.indexOf(r));
                }
            });
            const appRegion = new Region({
                name: RegionName.APPLICATION,
                startAddress: appStartAddress,
                regionSize: appEndAddress - appStartAddress,
                color: RegionColor.APPLICATION,
            });
            fileRegions = fileRegions.push(appRegion);
            dispatch(fileRegionsKnownAction(fileRegions));
        }
    };
}

// Update Bootloader region in parsed files
// Regard the Bootlader as a whole when there are gaps found in the Bootloader
export function updateFileBlRegion() {
    return (dispatch, getState) => {
        let fileRegions = getState().app.file.regions;
        let blRegion = fileRegions.find(r => r.name === RegionName.BOOTLOADER);
        if (!blRegion) {
            return;
        }

        const { deviceInfo } = getState().app.target;
        const blStartAddress = blRegion.startAddress;
        let blEndAddress;
        fileRegions.forEach(r => {
            if (r.name === RegionName.NONE
                && r.startAddress > blRegion.startAddress
                && r.startAddress + r.regionSize < deviceInfo.romSize
                && (!blEndAddress || blEndAddress <= r.startAddress)) {
                blEndAddress = r.startAddress + r.regionSize;
            }
        });

        // Merge Bootloader regions if more than one Bootloaders are detected.
        if (blStartAddress !== undefined && blEndAddress !== undefined) {
            fileRegions.forEach(r => {
                if (r.name === RegionName.NONE) {
                    fileRegions = fileRegions.remove(fileRegions.indexOf(r));
                }
            });
            const blRegionIndex = fileRegions.indexOf(blRegion);
            blRegion = blRegion.set('regionSize', blEndAddress - blStartAddress);
            fileRegions = fileRegions.set(blRegionIndex, blRegion);
            dispatch(fileRegionsKnownAction(fileRegions));
        }
    };
}

export function updateFileRegions() {
    return (dispatch, getState) => {
        dispatch(fileWarningRemoveAction());

        const { file, target } = getState().app;
        const overlaps = MemoryMap.overlapMemoryMaps(file.memMaps);
        const regions = getFileRegions(file.memMaps, target.deviceInfo);

        // Show file warning if overlapping.
        if (regions.find(r => r.fileNames && r.fileNames.length > 1)) {
            dispatch(addFileWarning('Some of the HEX files have overlapping data.'));
        }

        // Show file warning if out of displaying area.
        const outsideFlashBlocks = [];
        overlaps.forEach((overlap, startAddress) => {
            const endAddress = startAddress + overlap[0][1].length;
            const { uicrBaseAddr, romSize, pageSize } = target.deviceInfo;
            if ((startAddress < uicrBaseAddr && endAddress > romSize)
                || (startAddress >= uicrBaseAddr && endAddress > uicrBaseAddr + pageSize)) {
                outsideFlashBlocks.push(`${hexpad8(startAddress)}-${hexpad8(endAddress)}`);
            }
        });
        if (outsideFlashBlocks.length) {
            dispatch(addFileWarning(`There is data outside the user-writable areas (${outsideFlashBlocks.join(', ')}).`));
        }

        dispatch(fileRegionsKnownAction(regions));
        dispatch(updateDetectedRegionNames());
    };
}

export function removeFile(filePath) {
    return (dispatch, getState) => {
        const { loaded, memMaps } = getState().app.file;
        const newLoaded = { ...loaded };
        const newMemMaps = memMaps.filter(element => element[0] !== filePath);
        delete newLoaded[filePath];

        dispatch(fileParseAction(newLoaded, newMemMaps));
        dispatch(updateFileRegions());
        dispatch(targetActions.updateTargetWritable());
    };
}

export function closeFiles() {
    return dispatch => {
        dispatch(fileWarningRemoveAction());
        dispatch(filesEmptyAction());
        dispatch(updateFileRegions());
        dispatch(targetActions.updateTargetWritable());
    };
}

export function loadMruFiles() {
    return dispatch => {
        const files = persistentStore.get('mruFiles', []);
        dispatch(mruFilesLoadSuccessAction(files));
    };
}

function removeMruFile(filename) {
    const files = persistentStore.get('mruFiles', []);
    persistentStore.set('mruFiles', files.filter(file => file !== filename));
}

function addMruFile(filename) {
    const files = persistentStore.get('mruFiles', []);
    if (files.indexOf(filename) === -1) {
        files.unshift(filename);
        files.splice(10);
        persistentStore.set('mruFiles', files);
    }
}

function parseOneFile(filePath) {
    return async (dispatch, getState) => {
        const { loaded, memMaps } = getState().app.file;
        if (loaded[filePath]) {
            return;
        }

        const stats = await new Promise((resolve, reject) => {
            stat(filePath, (statsError, result) => {
                if (statsError) {
                    logger.error(`Could not open HEX file: ${statsError}`);
                    dispatch(errorDialogShowAction(statsError));
                    removeMruFile(filePath);
                    return reject();
                }
                return resolve(result);
            });
        });

        const data = await new Promise((resolve, reject) => {
            readFile(filePath, {}, (readError, result) => {
                logger.info('Parsing HEX file: ', filePath);
                logger.info('File was last modified at ', stats.mtime.toLocaleString());
                if (readError) {
                    logger.error(`Could not open HEX file: ${readError}`);
                    dispatch(errorDialogShowAction(readError));
                    removeMruFile(filePath);
                    return reject();
                }
                addMruFile(filePath);
                return resolve(result);
            });
        });

        let memMap;
        try {
            memMap = MemoryMap.fromHex(data.toString());
        } catch (e) {
            logger.error(`Could not open HEX file: ${e}`);
            dispatch(errorDialogShowAction(e));
            return;
        }

        memMap.forEach((block, address) => {
            const size = block.length;
            logger.info('Data block:',
                `${hexpad8(address)}-${hexpad8(address + size)} (${hexpad8(size)}`,
                ' bytes long)');

            // Check if the firmware's start address matches the MCU boot requirement.
            if (address === MCUBOOT_FW_START_ADDRESS) {
                dispatch(mcubootFileKnownAction(filePath));
            }
        });

        const newLoaded = {
            ...loaded,
            [filePath]: {
                filename: basename(filePath),
                modTime: stats.mtime,
                loadTime: new Date(),
                memMap,
            },
        };
        const newMemMaps = [
            ...memMaps,
            [filePath, memMap],
        ];
        dispatch(fileParseAction(newLoaded, newMemMaps));
        dispatch(updateFileRegions());
        dispatch(targetActions.updateTargetWritable());
    };
}

export function openFile(filename, ...rest) {
    return async dispatch => {
        if (filename) {
            dispatch(mcubootFileKnownAction(null));
            await dispatch(parseOneFile(filename));
            return dispatch(openFile(...rest));
        }
        return dispatch(loadMruFiles());
    };
}

export function openFileDialog() {
    return dispatch => {
        electron.remote.dialog.showOpenDialog(
            {
                title: 'Select a HEX file',
                filters: [{ name: 'Intel HEX files', extensions: ['hex', 'ihex'] }],
                properties: ['openFile', 'multiSelections'],
            },
            filenames => filenames && dispatch(openFile(...filenames)),
        );
    };
}

export function refreshAllFiles() {
    return (dispatch, getState) => Promise.all(
        Object.keys(getState().app.file.loaded).map(async filePath => {
            const entry = getState().app.file.loaded[filePath];
            try {
                const stats = statSync(filePath);
                if (entry.loadTime.getTime() < stats.mtime) {
                    dispatch(removeFile(filePath));
                    logger.info('Reloading: ', filePath);
                    await dispatch(parseOneFile(filePath));
                    return;
                }
                logger.info('Does not need to be reloaded: ', filePath);
            } catch (error) {
                logger.error(`Could not open HEX file: ${error}`);
                dispatch(errorDialogShowAction(error));
            }
        }),
    );
}

// Checks if the files have changed since they were loaded into the programmer UI.
// Will display a message box dialog.
// Expects a Map of filenames to instances of Date when the file was loaded into the UI.
// Returns a promise: it will resolve when the state of the files is known, or
// reject if the user wanted to cancel to manually check the status.
export function checkUpToDateFiles(dispatch, getState) {
    const { loaded } = getState().app.file;
    let newestFileTimestamp = -Infinity;

    // Check if files have changed since they were loaded
    return Promise.all(
        Object.keys(loaded).map(filePath => new Promise(resolve => {
            stat(filePath, (err, stats) => {
                if (loaded[filePath].loadTime.getTime() < stats.mtime) {
                    newestFileTimestamp = Math.max(newestFileTimestamp, stats.mtime);
                    return resolve(filePath);
                }
                return resolve();
            });
        })),
    ).then(filenames => filenames.filter(i => !!i)).then(filenames => {
        if (filenames.length === 0) {
            // Resolve immediately: no files were changed
            return Promise.resolve();
        }

        if (persistentStore.has('behaviour-when-files-not-up-to-date')) {
            // If the user has checked the "don't ask me again" checkbox before,
            // perform the saved behaviour
            const behaviour = persistentStore.get('behaviour-when-files-not-up-to-date');
            if (behaviour === 'ignore') {
                return Promise.resolve();
            }
            if (behaviour === 'reload') {
                return dispatch(refreshAllFiles());
            }
        }

        return new Promise((res, rej) => {
            const lastLoaded = (new Date(newestFileTimestamp)).toLocaleString();

            electron.remote.dialog.showMessageBox({
                type: 'warning',
                buttons: [
                    `Use old version (prior to ${lastLoaded})`,
                    'Reload all files and proceed',
                    'Cancel',
                ],
                message: `The following files have changed on disk since they were last loaded:\n${
                    filenames.join('\n')}`,
                checkboxLabel: 'Don\'t ask again',
            }, (button, doNotAskAgain) => {
                if (doNotAskAgain) {
                    persistentStore.set('behaviour-when-files-not-up-to-date',
                        button === 0 ? 'ignore' : 'reload');
                }

                if (button === 0) { // Use old version
                    return res();
                }
                if (button === 1) { // Reload
                    return dispatch(refreshAllFiles()).then(res);
                }

                // Cancel (button === 2)
                return rej();
            });
        });
    });
}
