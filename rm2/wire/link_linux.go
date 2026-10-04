//go:build linux

package wire

import (
	"fmt"
	"os"
	"strconv"
	"syscall"

	"matrixrm2/ui"
)

// DeviceLink talks to AppLoad's QTFB server: a SOCK_SEQPACKET unix socket for
// messages and a POSIX shared-memory RGB565 framebuffer.
type DeviceLink struct {
	fd  int
	fb  []byte
	shm *os.File
}

// DialDevice connects using the framebuffer key AppLoad passes in QTFB_KEY.
func DialDevice(socketPath, keyText string) (*DeviceLink, error) {
	key, err := strconv.ParseInt(keyText, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("QTFB_KEY %q is not a framebuffer key (was the app started by AppLoad with qtfb enabled?)", keyText)
	}
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_SEQPACKET, 0)
	if err != nil {
		return nil, fmt.Errorf("qtfb socket: %w", err)
	}
	if err := syscall.Connect(fd, &syscall.SockaddrUnix{Name: socketPath}); err != nil {
		syscall.Close(fd)
		return nil, fmt.Errorf("qtfb connect %s: %w (AppLoad not running?)", socketPath, err)
	}
	l := &DeviceLink{fd: fd}
	if err := l.Send(EncodeInit(int32(key))); err != nil {
		l.Close()
		return nil, err
	}
	m, err := l.Recv()
	if err != nil {
		l.Close()
		return nil, fmt.Errorf("qtfb init response: %w", err)
	}
	ev := DecodeServer(m)
	want := int32(ui.ScreenW * ui.ScreenH * 2)
	if ev.Type != MsgInitialize || ev.ShmSize != want {
		l.Close()
		return nil, fmt.Errorf("qtfb init: unexpected response type %d size %d (want %d bytes for 1404x1872 RGB565)", ev.Type, ev.ShmSize, want)
	}
	shm, err := os.OpenFile(fmt.Sprintf("/dev/shm/qtfb_%d", ev.ShmKey), os.O_RDWR, 0)
	if err != nil {
		l.Close()
		return nil, fmt.Errorf("qtfb framebuffer: %w", err)
	}
	fb, err := syscall.Mmap(int(shm.Fd()), 0, int(want), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		shm.Close()
		l.Close()
		return nil, fmt.Errorf("qtfb framebuffer mmap: %w", err)
	}
	l.shm, l.fb = shm, fb
	return l, nil
}

func (l *DeviceLink) Framebuffer() []byte { return l.fb }

func (l *DeviceLink) Send(m Msg) error {
	n, err := syscall.Write(l.fd, m[:])
	if err != nil {
		return fmt.Errorf("qtfb send: %w", err)
	}
	if n != MsgSize {
		return fmt.Errorf("qtfb send: short write %d", n)
	}
	return nil
}

func (l *DeviceLink) Recv() (Msg, error) {
	var m Msg
	n, err := syscall.Read(l.fd, m[:])
	if err != nil {
		return m, fmt.Errorf("qtfb recv: %w", err)
	}
	if n < 1 {
		return m, fmt.Errorf("qtfb recv: AppLoad closed the connection")
	}
	return m, nil
}

func (l *DeviceLink) Close() error {
	if l.fb != nil {
		syscall.Munmap(l.fb)
		l.fb = nil
	}
	if l.shm != nil {
		l.shm.Close()
	}
	if l.fd >= 0 {
		syscall.Write(l.fd, func() []byte { m := EncodeTerminate(); return m[:] }())
		syscall.Close(l.fd)
		l.fd = -1
	}
	return nil
}
