/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import dotenv from 'dotenv'
import Utils from './Utils.js'
dotenv.config()

export default class SetupType {

	getSetupType() {
		return process.env.SETUP_TYPE || 'standalone'
	}

	isExApp() {
		return this.getSetupType() === 'ex_app'
	}

	getNextcloudUrl() {
		return (this.isExApp() ? process.env.NEXTCLOUD_EX_APP_URL : this.getNextcloudSocketUrl())
	}

	getNextcloudSocketUrl() {
		return Utils.getOriginFromUrl(process.env.NEXTCLOUD_URL) || 'http://nextcloud.local'
	}

}
