//go:build !linux

package wire

import "errors"

type DeviceLink struct{ CaptureLink }

// DialDevice exists only on the device OS; the host build uses CaptureLink.
func DialDevice(socketPath, keyText string) (*DeviceLink, error) {
	return nil, errors.New("the QTFB device link is only available on Linux (the reMarkable); use --backend capture on the host")
}
