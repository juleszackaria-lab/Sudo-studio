#!/usr/bin/env python3
"""P69-C9: messages de memoire, en francais, avec la marche a suivre.

Ce module est volontairement SANS dependance (pas de Flask, pas de psutil) :
il doit pouvoir etre teste seul, et il doit rester utilisable le jour ou le
serveur principal est casse.

ASCII only.
"""


def ram_critical_message(model_id, avail_gb, threshold_gb, phase="le chargement",
                         petite_alternative=None):
    """Un echec RAM n'est jamais silencieux et dit QUOI FAIRE.

    avail_gb     : memoire libre au moment du declenchement
    threshold_gb : seuil de securite du garde-fou
    """
    try:
        a = float(avail_gb or 0)
    except (TypeError, ValueError):
        a = 0.0
    try:
        t = float(threshold_gb or 0)
    except (TypeError, ValueError):
        t = 0.0
    conseil = ("Fermez les applications lourdes (navigateur, conteneurs, autres "
               "editeurs), puis relancez le chargement")
    if petite_alternative:
        conseil += ", ou choisissez un modele plus petit (" + str(petite_alternative) + ")"
    return ("Chargement interrompu : la memoire libre est descendue a %.2f Go pendant %s, "
            "sous le seuil de securite de %.2f Go. Le modele %s a ete decharge pour "
            "eviter un plantage : aucun faux succes n'est annonce. %s."
            % (a, phase, t, str(model_id), conseil))
