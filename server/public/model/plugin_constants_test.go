// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package model

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMBEPluginID(t *testing.T) {
	require.Equal(t, "message-based-encryption", PluginIDMBE, "MBEPluginID must match the plugin.json id")
}

func TestCMEUnavailableMessageID(t *testing.T) {
	require.Equal(t, "app.cme.message_unavailable", CMEUnavailableMessageID,
		"i18n key shape must match the entry in server/i18n/en.json")
}
