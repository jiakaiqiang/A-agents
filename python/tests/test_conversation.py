from mewcode.conversation import Conversation


def test_messages_preserve_order_and_roles():
    conversation = Conversation()
    conversation.add_user("hello")
    conversation.add_assistant("hi")
    conversation.add_user("again")
    messages = conversation.messages()
    assert [(message.role, message.content) for message in messages] == [
        ("user", "hello"),
        ("assistant", "hi"),
        ("user", "again"),
    ]


def test_messages_returns_copy():
    conversation = Conversation()
    conversation.add_user("hello")
    messages = conversation.messages()
    messages.clear()
    assert len(conversation.messages()) == 1
