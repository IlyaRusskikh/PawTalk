"""Small OS boundary; transaction and release policy remain shared."""
import contextlib
import os
import subprocess
import sys
from pathlib import Path

WINDOWS = os.name == 'nt'


def admin():
    if WINDOWS:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    return os.geteuid() == 0


def sync_directory(path):
    if WINDOWS:
        return # File fsync + atomic replacement; directory fsync is not supported by Windows.
    fd = os.open(path,os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def host(*args,input=None):
    executable = os.environ.get('PAWTALK_MANAGER_HOST')
    if not executable or not Path(executable).is_absolute():
        raise ValueError('Run through the installed pawtalkctl.exe')
    return subprocess.run([executable,*map(str,args)],input=input,capture_output=True,timeout=180)


def secure(path):
    if WINDOWS and admin() and host('secure-tree',Path(os.path.abspath(path))).returncode:
        raise ValueError('Unable to secure managed files')


def protect(path):
    if WINDOWS:
        path = Path(path)
        path.mkdir(parents=True,exist_ok=True)
        # Replace ACLs/owner rather than retaining an explicit grant from a
        # pre-created directory. The host rejects links and unowned nonempty roots.
        if host('protect',Path(os.path.abspath(path))).returncode:
            raise ValueError('Unable to protect Manager directory; use a dedicated empty root')


def default_root():
    return str(Path(os.environ.get('ProgramData',r'C:\ProgramData'))/'PawTalk') if WINDOWS else '/'


class TerminalMaintenance(Exception):
    """An administrator or Manager installer requested console shutdown."""


class WindowsConsole:
    """Unicode console input and a VT screen, shared by conhost and Windows Terminal."""

    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        from msvcrt import get_osfhandle

        class Coord(c.Structure):
            _fields_ = [('x',w.SHORT),('y',w.SHORT)]

        class Rect(c.Structure):
            _fields_ = [('left',w.SHORT),('top',w.SHORT),('right',w.SHORT),('bottom',w.SHORT)]

        class BufferInfo(c.Structure):
            _fields_ = [('size',Coord),('cursor',Coord),('attributes',w.WORD),('window',Rect),('max_size',Coord)]

        class Key(c.Structure):
            _fields_ = [('down',w.BOOL),('repeat',w.WORD),('code',w.WORD),('scan',w.WORD),('char',w.WCHAR),('modifiers',w.DWORD)]

        class Mouse(c.Structure):
            _fields_ = [('point',Coord),('buttons',w.DWORD),('modifiers',w.DWORD),('flags',w.DWORD)]

        class Event(c.Union):
            _fields_ = [('key',Key),('mouse',Mouse)]

        class Record(c.Structure):
            _fields_ = [('kind',w.WORD),('event',Event)]

        api = c.WinDLL('kernel32',use_last_error=True)
        api.GetConsoleMode.argtypes = (w.HANDLE,c.POINTER(w.DWORD))
        api.SetConsoleMode.argtypes = (w.HANDLE,w.DWORD)
        api.GetConsoleScreenBufferInfo.argtypes = (w.HANDLE,c.POINTER(BufferInfo))
        api.ReadConsoleInputW.argtypes = (w.HANDLE,c.POINTER(Record),w.DWORD,c.POINTER(w.DWORD))
        api.WaitForSingleObject.argtypes = (w.HANDLE,w.DWORD)
        api.WaitForSingleObject.restype = w.DWORD
        api.OpenEventW.argtypes = (w.DWORD,w.BOOL,w.LPCWSTR)
        api.OpenEventW.restype = w.HANDLE
        api.CloseHandle.argtypes = (w.HANDLE,)
        self.api,self.byref,self.win_error = api,c.byref,c.WinError
        self.input = get_osfhandle(sys.stdin.fileno())
        self.output = get_osfhandle(sys.stdout.fileno())
        self.info,self.record,self.count = BufferInfo(),Record(),w.DWORD()
        self.input_mode = self.mode(self.input,w.DWORD())
        self.output_mode = self.mode(self.output,w.DWORD())
        self.left_down = False
        self.mouse = True
        event = os.environ.get('PAWTALK_TUI_CLOSE_EVENT')
        self.close_event = api.OpenEventW(0x00100000,False,event) if event else None # SYNCHRONIZE
        if event and not self.close_event:
            raise self.win_error()

    def mode(self,handle,value):
        if not self.api.GetConsoleMode(handle,self.byref(value)):
            raise self.win_error()
        return value.value

    def set_mode(self,handle,mode):
        if not self.api.SetConsoleMode(handle,mode):
            raise self.win_error()

    def write(self,text):
        sys.stdout.write(text)
        sys.stdout.flush()

    def enter(self):
        self.set_mode(self.output,self.output_mode | 0x0005) # Processed output and VT output.
        try:
            # Enable mouse/window events and disable Quick Edit, line input and echo.
            self.set_mode(self.input,(self.input_mode | 0x0099) & ~0x0246)
            self.write('\x1b[?1049h\x1b[?25l')
        except BaseException:
            self.leave()
            raise

    def leave(self):
        try:
            self.write('\x1b[0m\x1b[?25h\x1b[?1049l')
        finally:
            try:
                self.set_mode(self.input,self.input_mode)
            finally:
                self.set_mode(self.output,self.output_mode)

    @contextlib.contextmanager
    def active(self):
        try:
            self.enter()
            try:
                yield
            finally:
                self.leave()
        finally:
            if self.close_event:
                self.api.CloseHandle(self.close_event)

    @contextlib.contextmanager
    def suspend(self):
        self.leave()
        try:
            yield
        finally:
            self.enter()

    def dimensions(self):
        if not self.api.GetConsoleScreenBufferInfo(self.output,self.byref(self.info)):
            raise self.win_error()
        window = self.info.window
        return window.bottom-window.top+1,window.right-window.left+1

    def clear(self):
        self.frame = ['\x1b[H\x1b[2J']

    def draw(self,row,column,text,style):
        attr = {'normal':0,'bold':1,'dim':2,'selected':7}[style]
        self.frame.append(f'\x1b[{row+1};{column+1}H\x1b[{attr}m{text}\x1b[0m')

    def refresh(self):
        self.write(''.join(self.frame))

    def read(self):
        while True:
            if self.close_event and self.api.WaitForSingleObject(self.close_event,0) == 0:
                raise TerminalMaintenance()
            ready = self.api.WaitForSingleObject(self.input,100)
            if ready == 258: # WAIT_TIMEOUT lets Python deliver Ctrl+C while idle.
                continue
            if ready != 0 or not self.api.ReadConsoleInputW(self.input,self.byref(self.record),1,self.byref(self.count)):
                raise self.win_error()
            kind,event = self.record.kind,self.record.event
            if kind == 0x0001 and event.key.down:
                key = {9:'tab',13:'enter',27:'back',33:'page_up',34:'page_down',38:'up',40:'down'}.get(event.key.code)
                if event.key.char.lower() == 'q':
                    key = 'back'
                if key:
                    return key,-1,-1
            if kind == 0x0002:
                pressed = bool(event.mouse.buttons & 1)
                click = pressed and not self.left_down and event.mouse.flags == 0
                self.left_down = pressed
                if click:
                    self.dimensions()
                    return 'click',event.mouse.point.x-self.info.window.left,event.mouse.point.y-self.info.window.top
            if kind == 0x0004:
                return 'resize',-1,-1
