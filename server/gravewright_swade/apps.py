from django.apps import AppConfig


class SwadeConfig(AppConfig):
    name = 'gravewright_swade'
    label = 'gravewright_swade'
    verbose_name = 'Savage Worlds rules'
    default_auto_field = 'django.db.models.BigAutoField'

    def ready(self):
        from api.combat import register_provider
        from . import SYSTEM_ID
        from .combat import advance_effects
        register_provider(SYSTEM_ID, advance_effects=advance_effects)
