"""Regression coverage for the disposable Compose fixture's port allocation."""
from contextlib import closing
import socket
import unittest
from unittest.mock import patch
import compose_integration as fixture


class ComposePortTests(unittest.TestCase):
    def test_entire_group_avoids_ephemeral_source_ports(self):
        with patch.object(fixture.preflight,'check_ports') as check:
            port=fixture.choose_room_port(ephemeral_range=(32768,60999),candidates=[32767,32768,40000,60999,61000])
        self.assertEqual(port,61000)
        check.assert_called_once_with(61000)

    def test_registry_port_is_excluded_even_inside_a_candidate_group(self):
        with patch.object(fixture.preflight,'check_ports') as check:
            port=fixture.choose_room_port(exclude=(20002,),ephemeral_range=(32768,60999),candidates=[20000,22000])
        self.assertEqual(port,22000)
        check.assert_called_once_with(22000)

    def test_existing_tcp_and_udp_listeners_are_not_selected(self):
        ephemeral=(32768,65535)
        first=fixture.choose_room_port(ephemeral_range=ephemeral)
        second=fixture.choose_room_port(exclude=range(first,first+4),ephemeral_range=ephemeral)
        for offset,kind in [(0,socket.SOCK_STREAM),(1,socket.SOCK_STREAM),(2,socket.SOCK_DGRAM),(3,socket.SOCK_STREAM)]:
            with self.subTest(offset=offset),closing(socket.socket(socket.AF_INET,kind)) as listener:
                listener.bind(('0.0.0.0',first+offset))
                if kind==socket.SOCK_STREAM:listener.listen(1)
                selected=fixture.choose_room_port(ephemeral_range=ephemeral,candidates=[first,second])
                self.assertEqual(selected,second)

    def test_occupied_groups_fail_before_installation(self):
        with patch.object(fixture.preflight,'check_ports',side_effect=ValueError('occupied')):
            with self.assertRaisesRegex(RuntimeError,'No free room port group'):
                fixture.choose_room_port(ephemeral_range=(32768,60999),candidates=[20000,22000])


if __name__=='__main__':unittest.main()
