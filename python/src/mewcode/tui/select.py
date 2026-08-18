from textual.widgets import OptionList
from textual.widgets.option_list import Option


def provider_options(providers):
    return OptionList(*(Option(f"{p.name} ({p.model})") for p in providers))
